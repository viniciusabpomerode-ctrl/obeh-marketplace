// ============================================
// FUNÇÃO NETLIFY - INÍCIO DA CONEXÃO COM MERCADO PAGO
// Redireciona o vendedor para a tela de autorização do Mercado Pago
// para que ele conecte a própria conta e receba pagamentos direto,
// com a taxa da Obeh sendo descontada automaticamente (split payment).
//
// Precisa das variáveis de ambiente:
//   MP_CLIENT_ID     - Client ID da aplicação Obeh no Mercado Pago Developers
//   MP_REDIRECT_URI  - URL pública da função mp-oauth-callback
//                      (ex: https://obeh.com.br/.netlify/functions/mp-oauth-callback)
// ============================================
exports.handler = async (event) => {
  const MP_CLIENT_ID = process.env.MP_CLIENT_ID
  const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI

  if (!MP_CLIENT_ID || !MP_REDIRECT_URI) {
    return { statusCode: 500, body: 'Conexão com Mercado Pago não configurada no servidor.' }
  }

  const userId = event.queryStringParameters?.userId
  if (!userId) {
    return { statusCode: 400, body: 'Parâmetro userId é obrigatório.' }
  }

  const authUrl = new URL('https://auth.mercadopago.com/authorization')
  authUrl.searchParams.set('client_id', MP_CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('platform_id', 'mp')
  authUrl.searchParams.set('redirect_uri', MP_REDIRECT_URI)
  authUrl.searchParams.set('state', userId)

  return {
    statusCode: 302,
    headers: { Location: authUrl.toString() },
    body: ''
  }
}
