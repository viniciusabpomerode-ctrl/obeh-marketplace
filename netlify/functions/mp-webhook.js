// ============================================
// FUNÇÃO NETLIFY - WEBHOOK DO MERCADO PAGO
// O Mercado Pago chama essa função sempre que o status de um pagamento
// muda (aprovado, recusado, cancelado, etc). Como cada venda pode ter
// sido paga na conta do Mercado Pago de um vendedor diferente (split
// payment via OAuth), a gente não sabe de antemão qual access_token
// usar pra consultar o pagamento — então tenta um por um entre as
// contas conectadas até uma funcionar.
//
// Depois de achar o pagamento, usa o "external_reference" (que é o id
// da linha da tabela "vendas" criado em mp-criar-pagamento.js) pra
// atualizar o status da venda no Supabase.
//
// Precisa da variável de ambiente SUPABASE_SERVICE_ROLE_KEY (chave
// "service_role" do Supabase).
// ============================================
const { baixarEstoquePorReferencia } = require('./lib/baixar-estoque')

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

function mapearStatus(statusMp) {
  if (statusMp === 'approved') return 'pago'
  if (statusMp === 'rejected') return 'recusado'
  if (statusMp === 'cancelled' || statusMp === 'refunded' || statusMp === 'charged_back') return 'cancelado'
  return 'pendente'
}

function mapearStatusPreapproval(statusMp) {
  if (statusMp === 'authorized') return 'ativo'
  if (statusMp === 'paused') return 'pausado'
  if (statusMp === 'cancelled') return 'cancelado'
  return 'pendente'
}

async function processarPreapproval(preapprovalId) {
  if (!preapprovalId) return { statusCode: 200, body: 'ok' }

  try {
    const contasRes = await supabaseRequest('mercado_pago_contas?status=eq.conectado&select=access_token')
    const contas = await contasRes.json()

    let assinatura = null
    for (const conta of contas) {
      if (!conta.access_token) continue
      try {
        const res = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
          headers: { Authorization: `Bearer ${conta.access_token}` }
        })
        if (res.ok) {
          assinatura = await res.json()
          break
        }
      } catch (err) {
        // tenta a próxima conta
      }
    }

    if (!assinatura) {
      console.error('mp-webhook: não foi possível encontrar a assinatura', preapprovalId, 'em nenhuma conta conectada.')
      return { statusCode: 200, body: 'ok' }
    }

    const novoStatus = mapearStatusPreapproval(assinatura.status)

    await supabaseRequest(`apoiadores?preapproval_id=eq.${preapprovalId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: novoStatus, updated_at: new Date().toISOString() })
    })

    return { statusCode: 200, body: 'ok' }
  } catch (err) {
    console.error('Erro ao processar preapproval no webhook do Mercado Pago:', err)
    return { statusCode: 200, body: 'ok' }
  }
}

exports.handler = async (event) => {
  // O Mercado Pago manda o id do pagamento tanto via query string (?data.id=...&type=payment)
  // quanto no corpo da notificação, dependendo do formato (webhook novo vs IPN antigo).
  let paymentId = event.queryStringParameters?.['data.id'] || event.queryStringParameters?.id
  const topic = event.queryStringParameters?.type || event.queryStringParameters?.topic

  if (!paymentId && event.body) {
    try {
      const body = JSON.parse(event.body)
      paymentId = body?.data?.id || body?.id
    } catch (err) {
      // corpo não é JSON, ignora
    }
  }

  // Assinaturas de apoio às lojas (Preapproval) são tratadas separadamente
  if (topic === 'preapproval' || topic === 'subscription_preapproval') {
    return await processarPreapproval(paymentId)
  }

  // Só nos interessa notificação de pagamento
  if (topic && topic !== 'payment') {
    return { statusCode: 200, body: 'ok' }
  }

  if (!paymentId || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 200, body: 'ok' }
  }

  try {
    const contasRes = await supabaseRequest('mercado_pago_contas?status=eq.conectado&select=access_token')
    const contas = await contasRes.json()

    let pagamento = null

    for (const conta of contas) {
      if (!conta.access_token) continue
      try {
        const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { Authorization: `Bearer ${conta.access_token}` }
        })
        if (res.ok) {
          pagamento = await res.json()
          break
        }
      } catch (err) {
        // tenta a próxima conta
      }
    }

    if (!pagamento) {
      console.error('mp-webhook: não foi possível encontrar o pagamento', paymentId, 'em nenhuma conta conectada.')
      return { statusCode: 200, body: 'ok' }
    }

    const referencia = pagamento.external_reference
    if (!referencia) {
      return { statusCode: 200, body: 'ok' }
    }

    const novoStatus = mapearStatus(pagamento.status)

    // A referência pode ser um "pedido_id" (várias vendas pagas juntas, uma
    // por produto) ou, em vendas antigas, o "id" de uma única venda — os dois
    // formatos são tratados na mesma atualização.
    await supabaseRequest(`vendas?or=(pedido_id.eq.${referencia},id.eq.${referencia})`, {
      method: 'PATCH',
      body: JSON.stringify({ status: novoStatus })
    })

    // Baixa de estoque quando o pagamento é aprovado (lógica compartilhada
    // com verificar-pagamento.js, idempotente e à prova de migração pendente).
    if (novoStatus === 'pago') {
      await baixarEstoquePorReferencia(referencia)
    }

    return { statusCode: 200, body: 'ok' }
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err)
    // Sempre responde 200 pro Mercado Pago não ficar re-tentando indefinidamente
    return { statusCode: 200, body: 'ok' }
  }
}
