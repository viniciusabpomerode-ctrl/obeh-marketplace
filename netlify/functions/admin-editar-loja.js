// ============================================
// Netlify Function: admin-editar-loja
// Admin edita qualquer loja (bypass RLS)
// ============================================

const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_EMAIL = 'viniciusbirnecker@gmail.com'

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers
  }
  if (options.method === 'GET' || !options.method) delete headers['Content-Type']
  const res = await fetch(url, { ...options, headers })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase ${res.status}: ${err}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido' }) }
  }

  try {
    const body = JSON.parse(event.body)

    // Verificar admin
    const authHeader = event.headers.authorization || ''
    const token = authHeader.replace('Bearer ', '')
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    })
    if (!userRes.ok) return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Token inválido' }) }
    const { email } = await userRes.json()
    if (email !== ADMIN_EMAIL) return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Acesso negado' }) }

    const { loja_id, updates, produto_id, excluir_produto } = body

    if (excluir_produto && produto_id) {
      // Excluir produto
      await supabaseFetch(`produtos?id=eq.${produto_id}`, { method: 'DELETE' })
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) }
    }

    if (loja_id && updates) {
      // Editar loja
      await supabaseFetch(`lojas?id=eq.${loja_id}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(updates)
      })
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) }
    }

    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Parâmetros inválidos' }) }
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) }
  }
}
