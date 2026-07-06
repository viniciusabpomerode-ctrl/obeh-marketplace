// ============================================
// FUNÇÃO NETLIFY - CRIAR PAGAMENTO COM CARTÃO (Mercado Pago / split automático)
// Recebe os itens de UMA loja (carrinho já vem agrupado por loja do
// lado do cliente) + os dados do cartão já tokenizados no navegador
// pelo Card Payment Brick do Mercado Pago (front-end nunca vê nem
// manda o número do cartão pra Obeh — só o token gerado pelo SDK
// deles). Cria o pagamento na API de Pagamentos (/v1/payments) com o
// access_token do próprio vendedor, igual mp-criar-pix.js.
//
// IMPORTANTE: o campo de split aqui também é "application_fee" (API
// de Pagamentos), não "marketplace_fee" (esse é só do Checkout
// Preferences). A taxa incide só sobre o valor dos produtos, nunca
// sobre o frete.
//
// Cartão não tem desconto de Pix — só cupom da loja é aplicado aqui.
//
// Precisa da variável de ambiente SUPABASE_SERVICE_ROLE_KEY (chave
// "service_role" do Supabase).
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE_URL = process.env.SITE_URL || 'https://obeh.com.br'
const { calcularFretesPorLoja } = require('./lib/frete')

// Taxa fixa pra produto impulsionado (destaque=true), vale pra qualquer
// plano e só incide sobre as vendas daquele produto específico.
const TAXA_PRODUTO_IMPULSIONADO = 18

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

// Chama a mesma função usada pelo endpoint público calcular-frete.js
// diretamente (sem HTTP no meio) — garante que o valor cobrado aqui é
// sempre igual ao valor mostrado no carrinho.
async function buscarFreteMaisBarato(cepDestino, itens) {
  if (!cepDestino) return 0
  try {
    const fretes = await calcularFretesPorLoja(cepDestino, itens)
    const opcoes = fretes?.[0]?.opcoes || []
    if (opcoes.length === 0) return 0
    return Math.min(...opcoes.map(o => Number(o.preco) || 0))
  } catch (err) {
    console.error('Não foi possível calcular o frete, seguindo sem cobrar frete:', err.message)
    return 0
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido.' }
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('mp-criar-pagamento-cartao: SUPABASE_SERVICE_ROLE_KEY ausente.')
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corpo da requisição inválido.' }) }
  }

  const { itens, compradorId, cupomCodigo, cepDestino, cardFormData } = payload

  if (!Array.isArray(itens) || itens.length === 0 || !compradorId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'itens e compradorId são obrigatórios.' }) }
  }
  if (!cardFormData || !cardFormData.token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Dados do cartão não recebidos do formulário de pagamento.' }) }
  }

  try {
    // 1. Busca todos os produtos do grupo (todos devem ser da mesma loja)
    const ids = itens.map(i => i.produtoId).filter(Boolean)
    const produtoRes = await supabaseRequest(
      `produtos?id=in.(${ids.join(',')})&select=id,nome,preco,loja_id,user_id,destaque,lojas(id,nome_loja,user_id)`
    )
    const produtos = await produtoRes.json()

    if (produtos.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nenhum produto encontrado.' }) }
    }

    const lojaIdsUnicos = [...new Set(produtos.map(p => p.loja_id))]
    if (lojaIdsUnicos.length > 1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Todos os itens de uma cobrança precisam ser da mesma loja.' }) }
    }

    const vendedorId = produtos[0].user_id || produtos[0].lojas?.user_id
    const nomeLoja = produtos[0].lojas?.nome_loja || 'Loja'

    // 1b. Busca cupom da loja, se um código válido foi informado
    let cupom = null
    if (cupomCodigo) {
      const hoje = new Date().toISOString().slice(0, 10)
      const cupomRes = await supabaseRequest(
        `cupons?loja_id=eq.${produtos[0].loja_id}&codigo=eq.${encodeURIComponent(cupomCodigo)}&ativo=eq.true&select=*`
      )
      const cupons = await cupomRes.json()
      cupom = cupons.find(c => !c.validade || c.validade >= hoje) || null
    }

    // 2. Calcula o valor de cada item (com cupom, se houver — cartão não tem
    // desconto de Pix)
    const itensPagamento = []
    let valorProdutos = 0

    for (const item of itens) {
      const produto = produtos.find(p => p.id === item.produtoId)
      if (!produto) continue
      const quantidade = Number(item.quantidade || 1)
      let valorUnitario = Number(produto.preco)
      if (cupom) {
        valorUnitario = Math.round(valorUnitario * (1 - Number(cupom.desconto_percentual) / 100) * 100) / 100
      }
      const subtotal = Math.round(valorUnitario * quantidade * 100) / 100
      valorProdutos += subtotal
      itensPagamento.push({ produto, quantidade, subtotal })
    }
    valorProdutos = Math.round(valorProdutos * 100) / 100

    // 3. Calcula o frete pra esse grupo e soma no total cobrado
    const valorFrete = await buscarFreteMaisBarato(cepDestino, itens)
    const valorTotal = Math.round((valorProdutos + valorFrete) * 100) / 100

    // 4. Busca o plano do vendedor pra saber a taxa da Obeh — incide só sobre
    // os produtos, nunca sobre o frete. Produto impulsionado (destaque) paga
    // sempre 18%, não importa o plano.
    const usuarioRes = await supabaseRequest(`users?id=eq.${vendedorId}&select=id,plano`)
    const usuarios = await usuarioRes.json()
    const planoSlug = usuarios[0]?.plano || 'free'

    const planoRes = await supabaseRequest(`planos?slug=eq.${planoSlug}&select=taxa_percentual`)
    const planos = await planoRes.json()
    const taxaPercentual = Number(planos[0]?.taxa_percentual ?? 8)
    const valorTaxa = Math.round(itensPagamento.reduce((acc, ip) => {
      const taxaItem = ip.produto.destaque ? TAXA_PRODUTO_IMPULSIONADO : taxaPercentual
      return acc + ip.subtotal * (taxaItem / 100)
    }, 0) * 100) / 100

    // 5. Cartão exige que o vendedor tenha conectado o Mercado Pago (mesma
    // regra do Pix — sem fallback de link estático)
    const contaRes = await supabaseRequest(
      `mercado_pago_contas?user_id=eq.${vendedorId}&status=eq.conectado&select=access_token`
    )
    const contas = await contaRes.json()
    const accessTokenVendedor = contas[0]?.access_token

    if (!accessTokenVendedor) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Este vendedor ainda não conectou o Mercado Pago — pagamento com cartão não está disponível pra essa loja.' }) }
    }

    // 6. Registra uma linha de "vendas" por produto, todas com o mesmo pedido_id
    const pedidoId = `pedido_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const vendasParaCriar = itensPagamento.map((ip, i) => ({
      produto_id: ip.produto.id,
      comprador_id: compradorId,
      vendedor_id: vendedorId,
      quantidade: ip.quantidade,
      valor_total: ip.subtotal,
      valor_frete: i === 0 ? valorFrete : 0,
      pedido_id: pedidoId,
      status: 'pendente'
    }))

    const vendaRes = await supabaseRequest('vendas', {
      method: 'POST',
      prefer: 'return=representation',
      headers: { 'Content-Profile': 'public' },
      body: JSON.stringify(vendasParaCriar)
    })
    await vendaRes.json()

    // 7. Cria o pagamento com cartão na API de Pagamentos, usando o
    // access_token do PRÓPRIO vendedor. O campo de split aqui é
    // "application_fee". Os dados do formulário (token, installments,
    // payment_method_id, issuer_id, payer) vêm prontos do Card Payment Brick.
    const descricao = itensPagamento.length === 1
      ? itensPagamento[0].produto.nome
      : `${itensPagamento.length} produtos - ${nomeLoja}`

    const pagamentoRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessTokenVendedor}`,
        'X-Idempotency-Key': pedidoId
      },
      body: JSON.stringify({
        transaction_amount: valorTotal,
        token: cardFormData.token,
        description: descricao,
        installments: Number(cardFormData.installments) || 1,
        payment_method_id: cardFormData.payment_method_id,
        issuer_id: cardFormData.issuer_id,
        payer: cardFormData.payer,
        application_fee: valorTaxa,
        external_reference: pedidoId,
        notification_url: `${SITE_URL}/.netlify/functions/mp-webhook`
      })
    })

    const pagamentoData = await pagamentoRes.json()

    if (!pagamentoRes.ok) {
      console.error('Erro ao criar pagamento com cartão no Mercado Pago:', pagamentoData)
      return { statusCode: 502, body: JSON.stringify({ error: pagamentoData?.message || 'Não foi possível processar o cartão agora.' }) }
    }

    // Cartão pode voltar aprovado na hora, recusado na hora, ou em análise —
    // diferente do Pix, que fica sempre pendente até o comprador pagar
    if (pagamentoData.status === 'approved') {
      await supabaseRequest(`vendas?pedido_id=eq.${pedidoId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ status: 'pago' })
      })
    } else if (pagamentoData.status === 'rejected') {
      await supabaseRequest(`vendas?pedido_id=eq.${pedidoId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ status: 'recusado' })
      })
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        pedidoId,
        paymentId: pagamentoData.id,
        status: pagamentoData.status,
        statusDetail: pagamentoData.status_detail,
        valorTotal,
        valorFrete
      })
    }
  } catch (err) {
    console.error('Erro em mp-criar-pagamento-cartao:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao processar o cartão.' }) }
  }
}
