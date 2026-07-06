// ============================================
// FUNÇÃO NETLIFY - CRIAR PAGAMENTO (Mercado Pago / split payment)
// Recebe os itens de UMA loja (o carrinho já vem agrupado por loja do
// lado do cliente), calcula o valor dos produtos (com cupom), soma o
// frete (mesma lógica de calcular-frete.js) e cria UMA preferência de
// pagamento no Checkout Pro pra tudo junto, usando a própria conta
// conectada do vendedor (split automático da taxa da Obeh).
//
// A taxa da Obeh incide só sobre o valor dos produtos, nunca sobre o frete.
//
// Cada produto vira uma linha em "vendas" (histórico por produto), todas
// compartilhando o mesmo "pedido_id" pra serem atualizadas juntas quando
// o pagamento for confirmado (ver mp-webhook.js).
//
// Se o vendedor ainda não conectou a conta do Mercado Pago (OAuth), cai
// no modelo antigo: usa o link estático de pagamento cadastrado na loja
// (lojas.mercado_pago_link) e registra as vendas como pendentes mesmo
// assim, só que sem split automático de taxa nem frete embutido.
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

// Busca o frete mais barato disponível pra esse grupo de itens, chamando a
// mesma função usada pelo endpoint público calcular-frete.js diretamente
// (sem HTTP no meio) — assim o valor cobrado aqui é sempre igual ao valor
// mostrado no carrinho. Se não der pra calcular, segue sem cobrar frete a
// não travar a compra por causa disso.
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
    console.error('mp-criar-pagamento: SUPABASE_SERVICE_ROLE_KEY ausente.')
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corpo da requisição inválido.' }) }
  }

  const { itens, compradorId, cupomCodigo, cepDestino } = payload

  if (!Array.isArray(itens) || itens.length === 0 || !compradorId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'itens e compradorId são obrigatórios.' }) }
  }

  try {
    // 1. Busca todos os produtos do grupo (todos devem ser da mesma loja)
    const ids = itens.map(i => i.produtoId).filter(Boolean)
    const produtoRes = await supabaseRequest(
      `produtos?id=in.(${ids.join(',')})&select=id,nome,preco,loja_id,user_id,destaque,lojas(id,nome_loja,user_id,mercado_pago_link)`
    )
    const produtos = await produtoRes.json()

    if (produtos.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nenhum produto encontrado.' }) }
    }

    const lojaIdsUnicos = [...new Set(produtos.map(p => p.loja_id))]
    if (lojaIdsUnicos.length > 1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Todos os itens de uma cobrança precisam ser da mesma loja.' }) }
    }

    const lojaInfo = produtos[0].lojas
    const vendedorId = produtos[0].user_id || lojaInfo?.user_id

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

    // 2. Calcula o valor de cada item (com cupom, se houver)
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
      itensPagamento.push({ produto, quantidade, valorUnitario, subtotal })
    }
    valorProdutos = Math.round(valorProdutos * 100) / 100

    // 3. Calcula o frete pra esse grupo (mesmos itens) e soma no total cobrado
    const valorFrete = await buscarFreteMaisBarato(cepDestino, itens)
    const valorTotal = Math.round((valorProdutos + valorFrete) * 100) / 100

    // 4. Busca o plano do vendedor pra saber a taxa da Obeh — incide só sobre
    // os produtos, nunca sobre o frete. Produto impulsionado (destaque) paga
    // sempre 18%, não importa o plano — os outros produtos seguem a taxa
    // normal do plano.
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

    // 5. Verifica se o vendedor já conectou a conta do Mercado Pago
    const contaRes = await supabaseRequest(
      `mercado_pago_contas?user_id=eq.${vendedorId}&status=eq.conectado&select=access_token`
    )
    const contas = await contaRes.json()
    const accessTokenVendedor = contas[0]?.access_token

    // 6. Registra uma linha de "vendas" por produto, todas com o mesmo
    // pedido_id — assim o webhook consegue atualizar todas juntas quando o
    // pagamento confirmar (ver mp-webhook.js)
    const pedidoId = `pedido_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const vendasParaCriar = itensPagamento.map((ip, i) => ({
      produto_id: ip.produto.id,
      comprador_id: compradorId,
      vendedor_id: vendedorId,
      quantidade: ip.quantidade,
      valor_total: ip.subtotal,
      valor_frete: i === 0 ? valorFrete : 0, // frete só na primeira linha, pra não contar em dobro na soma
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

    // 7. Sem conta conectada: cai no link estático antigo (sem split automático nem frete embutido)
    if (!accessTokenVendedor) {
      const linkEstatico = lojaInfo?.mercado_pago_link
      if (!linkEstatico) {
        return { statusCode: 422, body: JSON.stringify({ error: 'Vendedor ainda não configurou um jeito de receber pagamentos.' }) }
      }
      // Guarda o link pra "Minhas compras" poder mostrar um botão de
      // continuar pagamento se o pedido ficar pendente. Isso é só um
      // "extra" — se a coluna ainda não existir no banco (ou qualquer outro
      // erro), não pode derrubar a compra que já foi registrada.
      try {
        await supabaseRequest(`vendas?pedido_id=eq.${pedidoId}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ init_point: linkEstatico })
        })
      } catch (err) {
        console.error('Não foi possível salvar o init_point pra retomada depois:', err.message)
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ initPoint: linkEstatico, pedidoId, splitAutomatico: false })
      }
    }

    // 8. Com conta conectada: cria a preferência no Checkout Pro com uma linha
    // por produto + uma linha de frete (se houver), usando o access_token do
    // PRÓPRIO vendedor. A "marketplace_fee" é retida automaticamente pela Obeh.
    const items = itensPagamento.map(ip => ({
      title: ip.produto.nome,
      quantity: ip.quantidade,
      unit_price: ip.valorUnitario,
      currency_id: 'BRL'
    }))
    if (valorFrete > 0) {
      items.push({ title: 'Frete', quantity: 1, unit_price: valorFrete, currency_id: 'BRL' })
    }

    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessTokenVendedor}`
      },
      body: JSON.stringify({
        items,
        marketplace_fee: valorTaxa,
        external_reference: pedidoId,
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

    // Guarda o link pra "Minhas compras" poder mostrar um botão de continuar
    // pagamento se o pedido ficar pendente (a pessoa fechou a aba, etc). Só
    // um "extra" — não pode derrubar a compra se a coluna ainda não existir.
    try {
      await supabaseRequest(`vendas?pedido_id=eq.${pedidoId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ init_point: prefData.init_point })
      })
    } catch (err) {
      console.error('Não foi possível salvar o init_point pra retomada depois:', err.message)
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ initPoint: prefData.init_point, pedidoId, splitAutomatico: true, valorTotal, valorFrete })
    }
  } catch (err) {
    console.error('Erro em mp-criar-pagamento:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao criar o pagamento.' }) }
  }
}
