// ============================================
// Netlify Function: admin-transferir-loja
// Admin transfere uma loja para um usuário (com merge se necessário)
// e opcionalmente dá um plano patrocinado por X meses
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

    // Verificar admin
    const authHeader = event.headers.authorization || ''
    const token = authHeader.replace('Bearer ', '')
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    })
    if (!userRes.ok) return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Token inválido' }) }
    const adminData = await userRes.json()
    if (adminData.email !== ADMIN_EMAIL) return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Acesso negado' }) }

    const { loja_id, email_destino, plano, meses } = body
    if (!loja_id) return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'ID da loja é obrigatório' }) }
    if (!email_destino) return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Email do destinatário é obrigatório' }) }

    // Buscar admin user_id
    const adminUsers = await supabaseFetch(`users?email=eq.${encodeURIComponent(adminData.email)}&select=id`)
    const adminUserId = adminUsers?.[0]?.id

    // Buscar a loja admin
    const lojas = await supabaseFetch(`lojas?id=eq.${encodeURIComponent(loja_id)}&criada_por_admin=eq.true&select=*`)
    const lojaAdmin = lojas?.[0]
    if (!lojaAdmin) return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Loja não encontrada ou não é do admin' }) }

    // Buscar usuário destino
    const destUsers = await supabaseFetch(`users?email=eq.${encodeURIComponent(email_destino.toLowerCase().trim())}&select=id,email,nome`)
    const userDestino = destUsers?.[0]
    if (!userDestino) return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Usuário não encontrado com esse email' }) }

    // Verificar se destino já tem loja
    const lojasDestino = await supabaseFetch(`lojas?user_id=eq.${encodeURIComponent(userDestino.id)}&select=*`)
    const lojaDestino = lojasDestino?.[0]

    if (lojaDestino) {
      // ===== MERGE =====
      // Mover produtos
      await supabaseFetch(`produtos?loja_id=eq.${encodeURIComponent(lojaAdmin.id)}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ loja_id: lojaDestino.id, user_id: userDestino.id })
      })

      // Mover cursos
      await supabaseFetch(`cursos?loja_id=eq.${encodeURIComponent(lojaAdmin.id)}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ loja_id: lojaDestino.id })
      })

      // Atualizar loja destino (preserva logo, banner, cores)
      await supabaseFetch(`lojas?id=eq.${encodeURIComponent(lojaDestino.id)}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          nome_loja: lojaDestino.nome_loja || lojaAdmin.nome_loja,
          descricao: (lojaDestino.descricao && lojaDestino.descricao.trim()) ? lojaDestino.descricao : lojaAdmin.descricao,
          categoria: lojaDestino.categoria || lojaAdmin.categoria,
          instagram: lojaDestino.instagram || lojaAdmin.instagram,
          whatsapp: lojaDestino.whatsapp || lojaAdmin.whatsapp,
          ativa: true
        })
      })

      // Deletar loja admin
      await supabaseFetch(`lojas?id=eq.${encodeURIComponent(lojaAdmin.id)}`, { method: 'DELETE' })

      // Patrocínio
      if (plano && plano !== 'free' && meses > 0) {
        await aplicarPatrocinio(userDestino.id, lojaDestino.id, adminUserId, plano, meses)
      }

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, merged: true, loja_id: lojaDestino.id, mensagem: 'Loja mesclada! Produtos transferidos, branding preservado.' }) }
    } else {
      // ===== TRANSFERÊNCIA DIRETA =====
      await supabaseFetch(`lojas?id=eq.${encodeURIComponent(lojaAdmin.id)}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: userDestino.id, criada_por_admin: false, ativa: true })
      })

      await supabaseFetch(`produtos?loja_id=eq.${encodeURIComponent(lojaAdmin.id)}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: userDestino.id })
      })

      if (plano && plano !== 'free' && meses > 0) {
        await aplicarPatrocinio(userDestino.id, lojaAdmin.id, adminUserId, plano, meses)
      }

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, merged: false, loja_id: lojaAdmin.id, mensagem: 'Loja transferida com sucesso!' }) }
    }
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) }
  }
}

async function aplicarPatrocinio(userId, lojaId, adminId, plano, meses) {
  const expiracao = new Date()
  expiracao.setMonth(expiracao.getMonth() + meses)

  await supabaseFetch(`users?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      plano,
      plano_patrocinado: plano,
      plano_patrocinado_expiracao: expiracao.toISOString()
    })
  })

  await supabaseFetch('patrocinios', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      loja_id: lojaId,
      user_id: userId,
      admin_id: adminId,
      plano,
      meses
    })
  })
}
