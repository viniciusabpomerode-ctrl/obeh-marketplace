// ============================================
// Netlify Function: admin-criar-loja
// Admin cria uma nova loja (oculta, sem dono real)
// ============================================

const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_EMAIL = 'viniciusbirnecker@gmail.com'

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido' }
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey)
    const body = JSON.parse(event.body)

    // Verificar se o usuário logado é o admin
    const authHeader = event.headers.authorization || ''
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user || user.email !== ADMIN_EMAIL) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Acesso negado' }) }
    }

    const { nome_loja, descricao, categoria, instagram, whatsapp } = body

    if (!nome_loja || !nome_loja.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Nome da loja é obrigatório' }) }
    }

    // Criar loja vinculada ao admin mas marcada como "criada pelo admin"
    const slug = nome_loja.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      + '-' + Date.now().toString(36)

    const { data: loja, error } = await supabase
      .from('lojas')
      .insert({
        user_id: user.id,
        nome_loja: nome_loja.trim(),
        slug,
        descricao: descricao || '',
        categoria: categoria || '',
        instagram: instagram || '',
        whatsapp: whatsapp || '',
        ativa: false,
        criada_por_admin: true
      })
      .select()
      .single()

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, loja })
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
