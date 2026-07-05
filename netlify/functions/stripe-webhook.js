// ============================================
// FUNÇÃO NETLIFY - WEBHOOK DO STRIPE
// Recebe eventos do Stripe (assinatura confirmada, renovada, cancelada)
// e atualiza o plano do usuário no Supabase.
//
// Precisa da variável de ambiente SUPABASE_SERVICE_ROLE_KEY (chave
// "service_role" do Supabase, NÃO a anon key) pra poder escrever no banco
// sem depender do usuário estar logado no navegador.
// ============================================
const Stripe = require('stripe')
const { sincronizarStatusProdutosComPlano } = require('./lib/sincronizar-plano-produtos')

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
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

async function ativarPlano(userId, plano, subscriptionId) {
  if (!userId || !plano) return

  await supabaseRequest(`users?id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ plano })
  })

  await supabaseRequest('assinaturas', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    headers: { 'Content-Profile': 'public' },
    body: JSON.stringify({
      user_id: userId,
      plano,
      status: 'ativa',
      inicio: new Date().toISOString(),
      stripe_subscription_id: subscriptionId || null
    })
  })

  await sincronizarStatusProdutosComPlano(userId)
}

async function cancelarPlano(userId, subscriptionId) {
  if (!userId) return

  await supabaseRequest(`users?id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ plano: null })
  })

  if (subscriptionId) {
    await supabaseRequest(`assinaturas?stripe_subscription_id=eq.${subscriptionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelada', fim: new Date().toISOString() })
    })
  }

  await sincronizarStatusProdutosComPlano(userId)
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido.' }
  }

  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Webhook do Stripe: variáveis de ambiente ausentes (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET ou SUPABASE_SERVICE_ROLE_KEY).')
    return { statusCode: 500, body: 'Webhook não configurado no servidor.' }
  }

  const stripe = Stripe(STRIPE_SECRET_KEY)
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature']
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body

  let stripeEvent
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Assinatura do webhook do Stripe inválida:', err.message)
    return { statusCode: 400, body: `Webhook Error: ${err.message}` }
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object
        if (session.mode === 'subscription') {
          const userId = session.metadata?.userId || session.client_reference_id
          const plano = session.metadata?.plano
          await ativarPlano(userId, plano, session.subscription)
        }
        break
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object
        const userId = sub.metadata?.userId
        const plano = sub.metadata?.plano
        if (sub.status === 'active' || sub.status === 'trialing') {
          await ativarPlano(userId, plano, sub.id)
        } else if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
          await cancelarPlano(userId, sub.id)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object
        await cancelarPlano(sub.metadata?.userId, sub.id)
        break
      }

      default:
        break
    }
  } catch (err) {
    console.error('Erro ao processar evento do Stripe no Supabase:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) }
}
