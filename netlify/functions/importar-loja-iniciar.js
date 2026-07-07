// ============================================
// FUNÇÃO NETLIFY - INICIAR IMPORTAÇÃO DE LOJA (rápida)
// Só valida o pedido, registra o consentimento (auditoria) e dispara a
// função em segundo plano (importar-loja-background.js) que faz o
// trabalho pesado. Responde na hora com o id da importação, pra o
// dashboard poder acompanhar o progresso consultando o Supabase direto.
//
// Precisa de SUPABASE_SERVICE_ROLE_KEY.
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
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function identificarPlataforma(url) {
  if (/artesanou\.com\.br/i.test(url)) return 'artesanou'
  if (/minhavenda\.com\.br/i.test(url)) return 'minhavenda'
  if (/akeba\.com\.br/i.test(url)) return 'akeba'
  return null
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido.' }
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corpo da requisição inválido.' }) }
  }

  const { userId, urlLoja, aceiteTermos, lojaId } = payload

  if (!userId || !urlLoja || aceiteTermos !== true) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId, urlLoja e o aceite dos termos são obrigatórios.' }) }
  }

  const plataforma = identificarPlataforma(urlLoja)
  if (!plataforma) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Essa plataforma de origem ainda não é suportada pra importação.' }) }
  }

  try {
    // Se veio lojaId (admin importando numa loja específica), usa ela
    let loja
    if (lojaId) {
      const lojas = await supabaseRequest(`lojas?id=eq.${lojaId}&select=id`)
      loja = lojas[0]
    } else {
      const lojas = await supabaseRequest(`lojas?user_id=eq.${userId}&select=id`)
      loja = lojas[0]
    }

    if (!loja) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Loja do vendedor não encontrada no Obeh.' }) }
    }

    const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || '').split(',')[0].trim() || null

    const importacoes = await supabaseRequest('importacoes_lojas', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify({ user_id: userId, loja_id: loja.id, url_origem: urlLoja, plataforma, ip, status: 'processando' })
    })
    const importacao = importacoes[0]

    // Dispara a função em segundo plano. Precisa do "await" aqui: sem ele, a
    // Lambda desta função pode congelar/finalizar antes do fetch sair de
    // verdade pela rede, e a importação nunca chega a começar. O await só
    // espera o Netlify ACEITAR a chamada (responde rápido, 202) — não espera
    // os até 15 minutos de processamento da função em segundo plano.
    await fetch(`${SITE_URL}/.netlify/functions/importar-loja-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, urlLoja, plataforma, lojaId: loja.id, importacaoId: importacao.id })
    }).catch(err => console.error('Falha ao disparar importar-loja-background:', err.message))

    return { statusCode: 200, body: JSON.stringify({ importacaoId: importacao.id }) }
  } catch (err) {
    console.error('Erro em importar-loja-iniciar:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao iniciar a importação: ' + err.message }) }
  }
}
