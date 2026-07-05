// ============================================
// SINCRONIZA STATUS DOS PRODUTOS COM O LIMITE DO PLANO
// Chamado sempre que o plano de um vendedor muda (upgrade ou downgrade,
// via stripe-webhook.js) — também é usado depois de uma importação de
// loja, já que ela pode trazer mais produtos do que o plano atual permite.
//
// Nunca mexe em produtos que o próprio vendedor pausou manualmente
// (status inativo com pendente_upgrade=false) — só em produtos marcados
// pendente_upgrade=true (esperando espaço) ou nos que estão ativos hoje.
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

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
  return res.json()
}

async function sincronizarStatusProdutosComPlano(vendedorId) {
  if (!vendedorId) return

  const usuarios = await supabaseRequest(`users?id=eq.${vendedorId}&select=plano`)
  const planoSlug = usuarios[0]?.plano || 'free'
  const planosRows = await supabaseRequest(`planos?slug=eq.${planoSlug}&select=limite_produtos`)
  const limite = planosRows[0]?.limite_produtos ?? null

  const lojas = await supabaseRequest(`lojas?user_id=eq.${vendedorId}&select=id`)
  const loja = lojas[0]
  if (!loja) return

  // Plano ilimitado: libera tudo que só estava esperando espaço
  if (limite === null || limite === undefined) {
    const pendentes = await supabaseRequest(`produtos?loja_id=eq.${loja.id}&pendente_upgrade=eq.true&select=id`)
    for (const p of pendentes) {
      await supabaseRequest(`produtos?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'ativo', pendente_upgrade: false }) })
    }
    return
  }

  const ativos = await supabaseRequest(`produtos?loja_id=eq.${loja.id}&status=eq.ativo&pendente_upgrade=eq.false&select=id&order=created_at.asc`)

  if (ativos.length > limite) {
    // Downgrade: desativa os produtos mais novos que excedem o novo limite
    const excedentes = ativos.slice(limite)
    for (const p of excedentes) {
      await supabaseRequest(`produtos?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'inativo', pendente_upgrade: true }) })
    }
  } else if (ativos.length < limite) {
    // Upgrade: libera produtos pendentes, na ordem original de criação, até preencher o novo limite
    const vagas = limite - ativos.length
    const pendentes = await supabaseRequest(`produtos?loja_id=eq.${loja.id}&pendente_upgrade=eq.true&select=id&order=created_at.asc&limit=${vagas}`)
    for (const p of pendentes) {
      await supabaseRequest(`produtos?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'ativo', pendente_upgrade: false }) })
    }
  }
}

module.exports = { sincronizarStatusProdutosComPlano }
