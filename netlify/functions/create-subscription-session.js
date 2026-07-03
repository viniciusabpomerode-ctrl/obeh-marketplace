// ============================================
// FUNÇÃO NETLIFY - CRIA SESSÃO DE ASSINATURA DO STRIPE
// (Planos Basic / Pro / Ultra da loja - NÃO é para comprar produtos)
// ============================================
const Stripe = require('stripe')

const PRICE_IDS = {
  basic: 'price_1Torlv3vXW7W5vhxkuVd97f7',
  pro: 'price_1ToroA3vXW7W5vhxv7SRbM5t',
  ultra: 'price_1ToroT3vXW7W5vhxMES2Bn7F'
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido.' }) }
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  if (!stripeSecretKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'STRIPE_SECRET_KEY não configurada nas variáveis de ambiente do Netlify.'
      })
    }
  }

  const stripe = Stripe(stripeSecretKey)

  try {
    const { plano, userId, email, successUrl, cancelUrl } = JSON.parse(event.body || '{}')

    const priceId = PRICE_IDS[plano]
    if (!priceId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Plano inválido.' }) }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      client_reference_id: userId || undefined,
      metadata: { userId: userId || '', plano },
      subscription_data: {
        metadata: { userId: userId || '', plano }
      },
      success_url: successUrl || `${event.headers.origin}/?assinatura=sucesso&plano=${plano}`,
      cancel_url: cancelUrl || `${event.headers.origin}/?assinatura=cancelada`
    })

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url })
    }
  } catch (err) {
    console.error('Erro ao criar sessão de assinatura do Stripe:', err)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    }
  }
}
