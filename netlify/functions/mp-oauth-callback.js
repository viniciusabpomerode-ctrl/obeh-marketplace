// ============================================
// FUNÇÃO NETLIFY - CALLBACK DA CONEXÃO COM MERCADO PAGO
// O Mercado Pago redireciona o vendedor pra cá depois que ele autoriza
// o acesso. Aqui a gente troca o "code" por um access_token de verdade
// e salva a conta conectada do vendedor no Supabase (tabela
// mercado_pago_contas), pra poder usar no split payment das vendas.
//
// Precisa das variáveis de ambiente:
//   MP_CLIENT_ID              - Client ID da aplicação Obeh no Mercado Pago Developers
//   MP_CLIENT_SECRET          - Client Secret da aplicação Obeh no Mercado Pago Developers
//   MP_REDIRECT_URI           - Precisa ser IGUAL à usada em mp-oauth-start.js
//   SUPABASE_SERVICE_ROLE_KEY - chave "service_role" do Supabase
// ============================================
const MP_CLIENT_ID = process.env.MP_CLIENT_ID
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI
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
      Prefer: options.prefer || 'return=minimal',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res
}

function redirecionarParaDashboard(status, mensagem) {
  const url = new URL('https://obeh.com.br/dashboard.html')
  url.searchParams.set('mp_conexao', status)
  if (mensagem) url.searchParams.set('mp_msg', mensagem)
  return { statusCode: 302, headers: { Location: url.toString() }, body: '' }
}

exports.handler = async (event) => {
  if (!MP_CLIENT_ID || !MP_CLIENT_SECRET || !MP_REDIRECT_URI || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('mp-oauth-callback: variáveis de ambiente ausentes.')
    return redirecionarParaDashboard('erro', 'Conexão com Mercado Pago não configurada no servidor.')
  }

  const code = event.queryStringParameters?.code
  const userId = event.queryStringParameters?.state
  const erroMp = event.queryStringParameters?.error

  if (erroMp) {
    return redirecionarParaDashboard('erro', 'Autorização cancelada no Mercado Pago.')
  }

  if (!code || !userId) {
    return redirecionarParaDashboard('erro', 'Parâmetros inválidos retornados pelo Mercado Pago.')
  }

  try {
    const tokenRes = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID,
        client_secret: MP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: MP_REDIRECT_URI
      })
    })

    const tokenData = await tokenRes.json()

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Erro ao trocar code por token no Mercado Pago:', tokenData)
      return redirecionarParaDashboard('erro', 'Não foi possível concluir a conexão com o Mercado Pago.')
    }

    await supabaseRequest('mercado_pago_contas', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      headers: { 'Content-Profile': 'public' },
      body: JSON.stringify({
        user_id: userId,
        merchant_id: tokenData.user_id ? String(tokenData.user_id) : null,
        public_key: tokenData.public_key || null,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        status: 'conectado',
        updated_at: new Date().toISOString()
      })
    })

    return redirecionarParaDashboard('sucesso')
  } catch (err) {
    console.error('Erro no callback do Mercado Pago:', err)
    return redirecionarParaDashboard('erro', 'Erro inesperado ao conectar com o Mercado Pago.')
  }
}
