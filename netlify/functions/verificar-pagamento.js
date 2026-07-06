// ============================================
// FUNÇÃO NETLIFY - VERIFICAR PAGAMENTO PIX MANUALMENTE
// Usado por "Minhas compras" quando um pedido Pix aparece como pendente —
// consulta o status direto na API do Mercado Pago (em vez de esperar o
// webhook), pro caso do webhook ter falhado em confirmar mas o pagamento já
// ter sido aprovado de verdade.
//
// Precisa de SUPABASE_SERVICE_ROLE_KEY.
// ============================================
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
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res.json()
}

const { baixarEstoquePorReferencia } = require('./lib/baixar-estoque')

function mapearStatus(statusMp) {
  if (statusMp === 'approved') return 'pago'
  if (statusMp === 'rejected') return 'recusado'
  if (statusMp === 'cancelled' || statusMp === 'refunded' || statusMp === 'charged_back') return 'cancelado'
  return 'pendente'
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

  const { pedidoId } = payload
  if (!pedidoId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'pedidoId é obrigatório.' }) }
  }

  try {
    const vendas = await supabaseRequest(`vendas?pedido_id=eq.${pedidoId}&select=id,status,vendedor_id,mp_payment_id&limit=1`)
    const venda = vendas[0]
    if (!venda) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Pedido não encontrado.' }) }
    }

    if (venda.status !== 'pendente') {
      return { statusCode: 200, body: JSON.stringify({ status: venda.status }) }
    }

    if (!venda.mp_payment_id) {
      return { statusCode: 200, body: JSON.stringify({ status: 'pendente', mensagem: 'Ainda sem informação suficiente pra consultar — aguarde.' }) }
    }

    const contas = await supabaseRequest(`mercado_pago_contas?user_id=eq.${venda.vendedor_id}&status=eq.conectado&select=access_token`)
    const accessToken = contas[0]?.access_token
    if (!accessToken) {
      return { statusCode: 200, body: JSON.stringify({ status: 'pendente' }) }
    }

    const pagamentoRes = await fetch(`https://api.mercadopago.com/v1/payments/${venda.mp_payment_id}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!pagamentoRes.ok) {
      return { statusCode: 200, body: JSON.stringify({ status: 'pendente' }) }
    }
    const pagamento = await pagamentoRes.json()
    const novoStatus = mapearStatus(pagamento.status)

    if (novoStatus !== 'pendente') {
      await supabaseRequest(`vendas?pedido_id=eq.${pedidoId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ status: novoStatus })
      })

      // Baixa de estoque (mesma lógica idempotente do mp-webhook.js —
      // não importa qual dos dois rodar primeiro, só desconta uma vez).
      if (novoStatus === 'pago') {
        await baixarEstoquePorReferencia(pedidoId)
      }
    }

    return { statusCode: 200, body: JSON.stringify({ status: novoStatus }) }
  } catch (err) {
    console.error('Erro em verificar-pagamento:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao verificar o pagamento.' }) }
  }
}
