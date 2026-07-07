// ============================================
// Netlify Function: admin-criar-loja
// Admin cria uma nova loja (oculta, sem dono real)
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
  // Para selects usamos GET, GET não pode ter body
  if (options.method === 'GET' || !options.method) {
    delete headers['Content-Type']
  }
  const res = await fetch(url, { ...options, headers })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase ${res.status}: ${err}`)
  }
  // GET com Prefer: return=representation precisa do location header
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido' }
  }

  try {
    const body = JSON.parse(event.body)

    // Verificar se o usuário logado é o admin
    const authHeader = event.headers.authorization || ''
    const token = authHeader.replace('Bearer ', '')
    
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    })
    if (!userRes.ok) return { statusCode: 403, body: JSON.stringify({ error: 'Token inválido' }) }
    const { email } = await userRes.json()
    if (email !== ADMIN_EMAIL) return { statusCode: 403, body: JSON.stringify({ error: 'Acesso negado' }) }

    const { nome_loja, descricao, categoria, instagram, whatsapp } = body
    if (!nome_loja || !nome_loja.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Nome da loja é obrigatório' }) }
    }

    // Buscar user_id do admin
    const users = await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}&select=id`)
    const adminUserId = users?.[0]?.id
    if (!adminUserId) return { statusCode: 500, body: JSON.stringify({ error: 'Admin não encontrado' }) }

    // Criar slug
    const slug = nome_loja.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      + '-' + Date.now().toString(36)

    const loja = await supabaseFetch('lojas', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        user_id: adminUserId,
        nome_loja: nome_loja.trim(),
        slug,
        descricao: descricao || '',
        categoria: categoria || '',
        instagram: instagram || '',
        whatsapp: whatsapp || '',
        ativa: false,
        criada_por_admin: true
      })
    })

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, loja: loja?.[0] || loja })
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
