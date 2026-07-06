// ============================================
// FUNÇÃO NETLIFY - CALCULAR FRETE
// Endpoint HTTP fino: recebe um CEP de destino + itens do carrinho e devolve
// o frete de cada loja envolvida. A lógica de verdade mora em
// lib/frete.js — a mesma função é chamada diretamente (sem HTTP no meio)
// pelas funções de pagamento (mp-criar-pix.js, mp-criar-pagamento.js,
// mp-criar-pagamento-cartao.js) pra garantir que o valor cobrado é sempre
// igual ao valor mostrado no carrinho.
// ============================================
const { calcularFretesPorLoja } = require('./lib/frete')

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido.' }
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corpo da requisição inválido.' }) }
  }

  const { cepDestino, itens } = payload
  const cepLimpo = String(cepDestino || '').replace(/\D/g, '')

  if (cepLimpo.length !== 8 || !Array.isArray(itens) || itens.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'cepDestino (8 dígitos) e itens são obrigatórios.' }) }
  }

  try {
    const fretes = await calcularFretesPorLoja(cepLimpo, itens)
    return { statusCode: 200, body: JSON.stringify({ fretes }) }
  } catch (err) {
    console.error('Erro em calcular-frete:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao calcular o frete.' }) }
  }
}
