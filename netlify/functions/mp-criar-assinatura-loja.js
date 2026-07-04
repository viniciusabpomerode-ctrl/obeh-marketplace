// ============================================
// FUNÇÃO NETLIFY - CRIAR ASSINATURA DE APOIO A UMA LOJA
// Cria uma assinatura recorrente no Mercado Pago (Preapproval) pra que
// um fã possa "apoiar" uma loja mensalmente e ganhar acesso a conteúdo
// exclusivo. O dinheiro vai direto pra conta do próprio vendedor (ele
// precisa ter conectado a conta do Mercado Pago via OAuth).
//
// Precisa da variável de ambiente SUPABASE_SERVICE_ROLE_KEY.
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
  return res.json()
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

  const { lojaId, apoiadorId, apoiadorEmail } = payload

  if (!lojaId || !apoiadorId || !apoiadorEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'lojaId, apoiadorId e apoiadorEmail são obrigatórios.' }) }
  }

  try {
    const lojas = await supabaseRequest(`lojas?id=eq.${lojaId}&select=id,nome_loja,user_id,apoio_ativo,apoio_valor_mensal`)
    const loja = lojas[0]

    if (!loja || !loja.apoio_ativo || !loja.apoio_valor_mensal) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Essa loja não tem apoio mensal ativado no momento.' }) }
    }

    const contas = await supabaseRequest(`mercado_pago_contas?user_id=eq.${loja.user_id}&status=eq.conectado&select=access_token`)
    const accessTokenVendedor = contas[0]?.access_token

    if (!accessTokenVendedor) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Essa loja ainda não conectou uma conta do Mercado Pago pra receber apoios.' }) }
    }

    const prefRes = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessTokenVendedor}`
      },
      body: JSON.stringify({
        reason: `Apoio à loja ${loja.nome_loja}`,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: Number(loja.apoio_valor_mensal),
          currency_id: 'BRL'
        },
        back_url: `${SITE_URL}/loja.html?id=${lojaId}`,
        payer_email: apoiadorEmail,
        external_reference: `${lojaId}:${apoiadorId}`
      })
    })

    const prefData = await prefRes.json()

    if (!prefRes.ok || !prefData.init_point) {
      console.error('Erro ao criar assinatura no Mercado Pago:', prefData)
      return { statusCode: 502, body: JSON.stringify({ error: 'Não foi possível iniciar o apoio no Mercado Pago.' }) }
    }

    await supabaseRequest('apoiadores', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      headers: { 'Content-Profile': 'public' },
      body: JSON.stringify({
        loja_id: lojaId,
        apoiador_id: apoiadorId,
        status: 'pendente',
        preapproval_id: prefData.id,
        valor_mensal: loja.apoio_valor_mensal,
        updated_at: new Date().toISOString()
      })
    })

    return { statusCode: 200, body: JSON.stringify({ initPoint: prefData.init_point }) }
  } catch (err) {
    console.error('Erro em mp-criar-assinatura-loja:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao criar o apoio.' }) }
  }
}
