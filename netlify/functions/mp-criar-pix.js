// ============================================
// FUNÇÃO NETLIFY - CRIAR PAGAMENTO PIX (Mercado Pago / split automático)
// Gera um pagamento Pix direto (QR code + código copia-e-cola) sem
// redirecionar o comprador pro Checkout Pro, usando a API de Pagamentos
// (/v1/payments) do Mercado Pago com o access_token do próprio vendedor
// (mesma conexão OAuth usada em mp-criar-pagamento.js).
//
// IMPORTANTE: o campo de split nessa API é "application_fee" — é
// diferente do "marketplace_fee" usado no /checkout/preferences. Usar o
// nome errado não dá erro nenhum, só faz a Obeh não receber a taxa.
//
// Precisa da variável de ambiente SUPABASE_SERVICE_ROLE_KEY (chave
// "service_role" do Supabase).
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE_URL = process.env.SITE_URL || 'https://obeh.com.br'

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    body: options.body,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido.' }
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('mp-criar-pix: SUPABASE_SERVICE_ROLE_KEY ausente.')
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corpo da requisição inválido.' }) }
  }

  const { produtoId, quantidade, compradorId, cupomCodigo } = payload

  if (!produtoId || !quantidade || !compradorId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'produtoId, quantidade e compradorId são obrigatórios.' }) }
  }

  try {
    // 1. Busca o produto e a loja/vendedor dono dele
    const produtoRes = await supabaseRequest(
      `produtos?id=eq.${produtoId}&select=id,nome,preco,loja_id,user_id,lojas(id,nome_loja,user_id)`
    )
    const produtos = await produtoRes.json()
    const produto = produtos[0]

    if (!produto) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Produto não encontrado.' }) }
    }

    const vendedorId = produto.user_id || produto.lojas?.user_id
    let valorUnitario = Number(produto.preco)

    // 1b. Aplica cupom de desconto da loja, se um código válido foi informado
    if (cupomCodigo) {
      const hoje = new Date().toISOString().slice(0, 10)
      const cupomRes = await supabaseRequest(
        `cupons?loja_id=eq.${produto.loja_id}&codigo=eq.${encodeURIComponent(cupomCodigo)}&ativo=eq.true&select=*`
      )
      const cupons = await cupomRes.json()
      const cupom = cupons.find(c => !c.validade || c.validade >= hoje)
      if (cupom) {
        valorUnitario = Math.round(valorUnitario * (1 - Number(cupom.desconto_percentual) / 100) * 100) / 100
      }
    }

    const valorTotal = Math.round(valorUnitario * Number(quantidade) * 100) / 100

    // 2. Busca o plano do vendedor pra saber a taxa da Obeh
    const usuarioRes = await supabaseRequest(`users?id=eq.${vendedorId}&select=id,plano`)
    const usuarios = await usuarioRes.json()
    const planoSlug = usuarios[0]?.plano || 'free'

    const planoRes = await supabaseRequest(`planos?slug=eq.${planoSlug}&select=taxa_percentual`)
    const planos = await planoRes.json()
    const taxaPercentual = Number(planos[0]?.taxa_percentual ?? 5)
    const valorTaxa = Math.round(valorTotal * (taxaPercentual / 100) * 100) / 100

    // 3. Pix exige que o vendedor tenha conectado o Mercado Pago (não existe
    // fallback de link estático pra pagamento direto via Pix)
    const contaRes = await supabaseRequest(
      `mercado_pago_contas?user_id=eq.${vendedorId}&status=eq.conectado&select=access_token`
    )
    const contas = await contaRes.json()
    const accessTokenVendedor = contas[0]?.access_token

    if (!accessTokenVendedor) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Este vendedor ainda não conectou o Mercado Pago — Pix não está disponível pra essa loja.' }) }
    }

    // 4. Busca os dados do comprador (Pix exige e-mail, nome e CPF do pagador)
    const compradorRes = await supabaseRequest(`users?id=eq.${compradorId}&select=nome,email,cpf`)
    const compradores = await compradorRes.json()
    const comprador = compradores[0]

    if (!comprador?.email) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Não foi possível encontrar o e-mail do comprador.' }) }
    }
    const cpfLimpo = (comprador.cpf || '').replace(/\D/g, '')
    if (!cpfLimpo) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Cadastre seu CPF no perfil antes de pagar com Pix.' }) }
    }

    const [primeiroNome, ...restoNome] = (comprador.nome || 'Comprador Obeh').trim().split(' ')

    // 5. Registra a venda como pendente
    const vendaRes = await supabaseRequest('vendas', {
      method: 'POST',
      prefer: 'return=representation',
      headers: { 'Content-Profile': 'public' },
      body: JSON.stringify({
        produto_id: produtoId,
        comprador_id: compradorId,
        vendedor_id: vendedorId,
        quantidade,
        valor_total: valorTotal,
        status: 'pendente'
      })
    })
    const vendas = await vendaRes.json()
    const venda = vendas[0]

    // 6. Cria o pagamento Pix na API de Pagamentos, usando o access_token do
    // PRÓPRIO vendedor. O campo de split aqui é "application_fee" (não
    // "marketplace_fee" — esse é só do /checkout/preferences).
    const pagamentoRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessTokenVendedor}`,
        'X-Idempotency-Key': String(venda?.id || `${produtoId}-${Date.now()}`)
      },
      body: JSON.stringify({
        transaction_amount: valorTotal,
        description: produto.nome,
        payment_method_id: 'pix',
        payer: {
          email: comprador.email,
          first_name: primeiroNome,
          last_name: restoNome.join(' ') || primeiroNome,
          identification: { type: 'CPF', number: cpfLimpo }
        },
        application_fee: valorTaxa,
        external_reference: String(venda?.id || ''),
        notification_url: `${SITE_URL}/.netlify/functions/mp-webhook`
      })
    })

    const pagamentoData = await pagamentoRes.json()
    const qrCode = pagamentoData?.point_of_interaction?.transaction_data?.qr_code
    const qrCodeBase64 = pagamentoData?.point_of_interaction?.transaction_data?.qr_code_base64

    if (!pagamentoRes.ok || !qrCode) {
      console.error('Erro ao criar pagamento Pix no Mercado Pago:', pagamentoData)
      return { statusCode: 502, body: JSON.stringify({ error: pagamentoData?.message || 'Não foi possível gerar o Pix agora.' }) }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        vendaId: venda?.id,
        paymentId: pagamentoData.id,
        qrCode,
        qrCodeBase64
      })
    }
  } catch (err) {
    console.error('Erro em mp-criar-pix:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao gerar o Pix.' }) }
  }
}
