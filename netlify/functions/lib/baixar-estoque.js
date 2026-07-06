// ============================================
// BAIXA DE ESTOQUE APÓS PAGAMENTO APROVADO
// Compartilhado entre mp-webhook.js e verificar-pagamento.js — os dois
// caminhos que podem marcar uma venda como "pago". Idempotente: usa a
// coluna "estoque_baixado" da tabela vendas pra nunca descontar duas
// vezes (webhook do MP pode ser chamado múltiplas vezes pro mesmo
// pagamento, e o "verificar agora" pode rodar em paralelo).
//
// MIGRAÇÃO NECESSÁRIA (rodar no Supabase):
//   alter table vendas add column estoque_baixado boolean not null default false;
//
// Enquanto a migração não rodar, tudo aqui falha silenciosamente
// (try/catch) — o fluxo principal de pagamento nunca é afetado.
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function req(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    body: options.body,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=minimal'
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res
}

// referencia = pedido_id (várias vendas) ou id de uma venda antiga
async function baixarEstoquePorReferencia(referencia) {
  try {
    const vendasRes = await req(
      `vendas?or=(pedido_id.eq.${referencia},id.eq.${referencia})&estoque_baixado=is.false&select=id,produto_id,quantidade`,
      { prefer: 'return=representation' }
    )
    const vendas = await vendasRes.json()

    for (const v of vendas) {
      if (!v.produto_id) continue
      try {
        // Marca como baixado ANTES de descontar, filtrando por
        // estoque_baixado=false — se duas execuções concorrerem, só a
        // que realmente alterou a linha (retorna 1 registro) desconta.
        const marcouRes = await req(
          `vendas?id=eq.${v.id}&estoque_baixado=is.false`,
          { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ estoque_baixado: true }) }
        )
        const marcadas = await marcouRes.json()
        if (!marcadas || marcadas.length === 0) continue // outra execução já baixou

        const prodRes = await req(`produtos?id=eq.${v.produto_id}&select=estoque,sob_encomenda`, { prefer: 'return=representation' })
        const prods = await prodRes.json()
        const produto = prods[0]
        if (!produto) continue
        // Produto sob encomenda não controla estoque
        if (produto.sob_encomenda) continue
        if (produto.estoque === null || produto.estoque === undefined) continue

        const novoEstoque = Math.max(0, Number(produto.estoque) - (Number(v.quantidade) || 1))
        await req(`produtos?id=eq.${v.produto_id}`, {
          method: 'PATCH',
          body: JSON.stringify(novoEstoque === 0 ? { estoque: 0, status: 'pausado' } : { estoque: novoEstoque })
        })
      } catch (errItem) {
        console.error('baixar-estoque: falha no produto', v.produto_id, errItem.message)
      }
    }
  } catch (err) {
    // Coluna estoque_baixado pode não existir ainda (migração pendente) — nunca quebra o pagamento.
    console.error('baixar-estoque: pulado (migração pendente?):', err.message)
  }
}

module.exports = { baixarEstoquePorReferencia }
