// ============================================
// FUNÇÃO NETLIFY - CRIA SESSÃO DE ASSINATURA DO STRIPE (Embedded Checkout)
// (Planos Basic / Pro / Ultra da loja - NÃO é para comprar produtos)
//
// Cada plano tem 2 preços no Stripe: o normal e uma promoção válida só nas
// primeiras 5 horas depois do primeiro login do usuário (primeiro_login_em).
// ============================================
const Stripe = require('stripe')

const PRICE_IDS = {
  basic: {
    regular: 'price_1Tp8kP3vXW7W5vhxBQZcc6W6', // R$ 9,99
    promo: 'price_1Torlv3vXW7W5vhxkuVd97f7'    // R$ 6,99
  },
  pro: {
    regular: 'price_1ToroA3vXW7W5vhxv7SRbM5t', // R$ 14,99
    promo: 'price_1Tp8mW3vXW7W5vhxSQYWtJgW'    // R$ 9,99
  },
  ultra: {
    regular: 'price_1ToroT3vXW7W5vhxMES2Bn7F', // R$ 29,99
    promo: 'price_1Tp8oW3vXW7W5vhxJxrpCdH4'    // R$ 14,99
  }
}

const PROMO_JANELA_HORAS = 5

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
    const { plano, userId, email, returnUrl, primeiroLoginEm } = JSON.parse(event.body || '{}')

    const precos = PRICE_IDS[plano]
    if (!precos) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Plano inválido.' }) }
    }

    // Verifica se o usuário ainda está dentro da janela de 5h do primeiro login
    let usaPromo = false
    if (primeiroLoginEm) {
      const primeiroLogin = new Date(primeiroLoginEm)
      const horasDesdeOPrimeiroLogin = (Date.now() - primeiroLogin.getTime()) / (1000 * 60 * 60)
      usaPromo = horasDesdeOPrimeiroLogin >= 0 && horasDesdeOPrimeiroLogin <= PROMO_JANELA_HORAS
    }

    const priceId = usaPromo ? precos.promo : precos.regular

    const origin = event.headers.origin || `https://${event.headers.host}`

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ui_mode: 'embedded_page',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      client_reference_id: userId || undefined,
      metadata: { userId: userId || '', plano, promo: usaPromo ? 'sim' : 'nao' },
      subscription_data: {
        metadata: { userId: userId || '', plano, promo: usaPromo ? 'sim' : 'nao' }
      },
      return_url: returnUrl || `${origin}/index.html?assinatura=sucesso&plano=${plano}`
    })

    return {
      statusCode: 200,
      body: JSON.stringify({ clientSecret: session.client_secret, promo: usaPromo })
    }
  } catch (err) {
    console.error('Erro ao criar sessão de assinatura do Stripe:', err)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    }
  }
}
