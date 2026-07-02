// ============================================
// FUNÇÃO NETLIFY - CRIA SESSÃO DE CHECKOUT DO STRIPE
// ============================================
const Stripe = require('stripe')

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
    const { itens, successUrl, cancelUrl } = JSON.parse(event.body || '{}')

    if (!Array.isArray(itens) || itens.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Carrinho vazio.' }) }
    }

    const line_items = itens.map((item) => ({
      quantity: item.quantidade || 1,
      price_data: {
        currency: 'brl',
        unit_amount: Math.round(Number(item.preco) * 100),
        product_data: {
          name: item.nome,
          images: item.imagem ? [item.imagem] : undefined
        }
      }
    }))

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: successUrl || `${event.headers.origin}/?compra=sucesso`,
      cancel_url: cancelUrl || `${event.headers.origin}/?compra=cancelada`
    })

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url })
    }
  } catch (err) {
    console.error('Erro ao criar sessão do Stripe:', err)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    }
  }
}
