// ============================================
// Netlify Function: admin-excluir-loja
// Admin exclui uma loja completa (produtos + cursos + imagens R2)
// ============================================

const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_EMAIL = 'viniciusbirnecker@gmail.com'
const SITE_URL = process.env.SITE_URL || 'https://obeh.com.br'

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers
  }
  if (options.method === 'GET' || !options.method) {
    delete headers['Content-Type']
  }
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
    return { statusCode: 405, body: 'Método não permitido' }
  }

  try {
    const body = JSON.parse(event.body)
    const { loja_id } = body

    // Verificar admin
    const authHeader = event.headers.authorization || ''
    const token = authHeader.replace('Bearer ', '')
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    })
    if (!userRes.ok) return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Token inválido' }) }
    const { email } = await userRes.json()
    if (email !== ADMIN_EMAIL) return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Acesso negado' }) })

    if (!loja_id) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'ID da loja é obrigatório' }) }
    }

    // Buscar imagens antes de deletar
    const [loja, produtos, cursos] = await Promise.all([
      supabaseFetch(`lojas?id=eq.${loja_id}&select=logo,banner`),
      supabaseFetch(`produtos?loja_id=eq.${loja_id}&select=fotos`),
      supabaseFetch(`cursos?loja_id=eq.${loja_id}&select=capa_url`)
    ])

    // Deletar produtos, cursos, loja
    await supabaseFetch(`produtos?loja_id=eq.${loja_id}`, { method: 'DELETE' })
    await supabaseFetch(`cursos?loja_id=eq.${loja_id}`, { method: 'DELETE' })
    await supabaseFetch(`lojas?id=eq.${loja_id}`, { method: 'DELETE' })

    // Deletar imagens do R2
    const lojaData = loja?.[0]
    const imagens = [
      lojaData?.logo, lojaData?.banner,
      ...(produtos || []).flatMap(p => (p.fotos || []).filter(Boolean)),
      ...(cursos || []).map(c => c.capa_url).filter(Boolean)
    ].filter(Boolean)

    if (imagens.length > 0) {
      try {
        await fetch(`${SITE_URL}/.netlify/functions/r2-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: imagens })
        })
      } catch (err) {
        console.error('Erro ao deletar imagens R2:', err.message)
      }
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) }
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) }
  }
}
