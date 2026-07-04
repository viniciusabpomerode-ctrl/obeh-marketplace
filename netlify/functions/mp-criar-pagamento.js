// ============================================
// FUNÇÃO NETLIFY - CRIAR PAGAMENTO (Mercado Pago / split payment)
// Recebe os dados do produto/quantidade/comprador vindos do carrinho,
// calcula a taxa da Obeh de acordo com o plano do vendedor, cria uma
// preferência de pagamento no Mercado Pago (Checkout Pro) usando a
// própria conta conectada do vendedor (quando conectada via OAuth) e
// registra a venda na tabela "vendas" como pendente até o webhook
// confirmar o pagamento.
//
// Se o vendedor ainda não conectou a conta do Mercado Pago (OAuth),
// cai no modelo antigo: usa o link estático de pagamento cadastrado
// na loja (lojas.mercado_pago_link) e registra a venda como pendente
// mesmo assim, só que sem split automático de taxa.
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
    console.error('mp-criar-pagamento: SUPABASE_SERVICE_ROLE_KEY ausente.')
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corpo da requisição inválido.' }) }
  }

  const { produtoId, quantidade, compradorId } = payload

  if (!produtoId || !quantidade || !compradorId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'produtoId, quantidade e compradorId são obrigatórios.' }) }
  }

  try {
    // 1. Busca o produto e a loja/vendedor dono dele
    const produtoRes = await supabaseRequest(
      `produtos?id=eq.${produtoId}&select=id,nome,preco,loja_id,user_id,lojas(id,nome_loja,user_id,mercado_pago_link)`
    )
    const produtos = await produtoRes.json()
    const produto = produtos[0]

    if (!produto) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Produto não encontrado.' }) }
    }

    const vendedorId = produto.user_id || produto.lojas?.user_id
    const valorUnitario = Number(produto.preco)
    const valorTotal = Math.round(valorUnitario * Number(quantidade) * 100) / 100

    // 2. Busca o plano do vendedor pra saber a taxa da Obeh
    const usuarioRes = await supabaseRequest(`users?id=eq.${vendedorId}&select=id,plano`)
    const usuarios = await usuarioRes.json()
    const planoSlug = usuarios[0]?.plano || 'free'

    const planoRes = await supabaseRequest(`planos?slug=eq.${planoSlug}&select=taxa_percentual`)
    const planos = await planoRes.json()
    const taxaPercentual = Number(planos[0]?.taxa_percentual ?? 5)
    const valorTaxa = Math.round(valorTotal * (taxaPercentual / 100) * 100) / 100

    // 3. Verifica se o vendedor já conectou a conta do Mercado Pago
    const contaRes = await supabaseRequest(
      `mercado_pago_contas?user_id=eq.${vendedorId}&status=eq.conectado&select=access_token`
    )
    const contas = await contaRes.json()
    const accessTokenVendedor = contas[0]?.access_token

    // 4. Registra a venda como pendente
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

    // 5. Sem conta conectada: cai no link estático antigo (sem split automático)
    if (!accessTokenVendedor) {
      const linkEstatico = produto.lojas?.mercado_pago_link
      if (!linkEstatico) {
        return { statusCode: 422, body: JSON.stringify({ error: 'Vendedor ainda não configurou um jeito de receber pagamentos.' }) }
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ initPoint: linkEstatico, vendaId: venda?.id, splitAutomatico: false })
      }
    }

    // 6. Com conta conectada: cria a preferência no Checkout Pro do Mercado Pago,
    // usando o access_token do PRÓPRIO vendedor. A "marketplace_fee" é retida
    // automaticamente pela Obeh (dona da aplicação usada no OAuth).
    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessTokenVendedor}`
      },
      body: JSON.stringify({
        items: [
          {
            title: produto.nome,
            quantity: Number(quantidade),
            unit_price: valorUnitario,
            currency_id: 'BRL'
          }
        ],
        marketplace_fee: valorTaxa,
        external_reference: String(venda?.id || ''),
        back_urls: {
          success: `${SITE_URL}/carrinho.html?pagamento=sucesso`,
          failure: `${SITE_URL}/carrinho.html?pagamento=falha`,
          pending: `${SITE_URL}/carrinho.html?pagamento=pendente`
        },
        auto_return: 'approved',
        notification_url: `${SITE_URL}/.netlify/functions/mp-webhook`
      })
    })

    const prefData = await prefRes.json()

    if (!prefRes.ok || !prefData.init_point) {
      console.error('Erro ao criar preferência no Mercado Pago:', prefData)
      return { statusCode: 502, body: JSON.stringify({ error: 'Não foi possível iniciar o pagamento no Mercado Pago.' }) }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ initPoint: prefData.init_point, vendaId: venda?.id, splitAutomatico: true })
    }
  } catch (err) {
    console.error('Erro em mp-criar-pagamento:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao criar o pagamento.' }) }
  }
}
