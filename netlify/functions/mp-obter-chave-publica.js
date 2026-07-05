// ============================================
// FUNÇÃO NETLIFY - OBTER CHAVE PÚBLICA DO VENDEDOR (Mercado Pago)
// O Card Payment Brick roda no navegador do comprador e precisa da
// "public_key" da conta do MESMO vendedor que vai receber o pagamento
// (pra tokenizar o cartão do lado certo da conta). Como a tabela
// "mercado_pago_contas" guarda o access_token (secreto) junto, o
// cliente não pode ler essa tabela direto — essa função devolve só o
// campo público, usando a service_role key no servidor.
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Método não permitido.' }
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('mp-obter-chave-publica: SUPABASE_SERVICE_ROLE_KEY ausente.')
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  const lojaId = event.queryStringParameters?.lojaId
  if (!lojaId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'lojaId é obrigatório.' }) }
  }

  try {
    const lojaRes = await fetch(`${SUPABASE_URL}/rest/v1/lojas?id=eq.${lojaId}&select=user_id`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
    })
    const lojas = await lojaRes.json()
    const vendedorId = lojas[0]?.user_id
    if (!vendedorId) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Loja não encontrada.' }) }
    }

    const contaRes = await fetch(
      `${SUPABASE_URL}/rest/v1/mercado_pago_contas?user_id=eq.${vendedorId}&status=eq.conectado&select=public_key`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    )
    const contas = await contaRes.json()
    const publicKey = contas[0]?.public_key

    if (!publicKey) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Este vendedor ainda não conectou o Mercado Pago — pagamento com cartão não está disponível pra essa loja.' }) }
    }

    return { statusCode: 200, body: JSON.stringify({ publicKey }) }
  } catch (err) {
    console.error('Erro em mp-obter-chave-publica:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao buscar a chave pública.' }) }
  }
}
