// ============================================
// FUNÇÃO NETLIFY - IMPORTAR AVALIAÇÕES DE UMA LOJA DE ORIGEM
// Separado da importação de produtos (importar-loja-iniciar.js): esse aqui
// só traz as avaliações públicas da página "/loja/<slug>/avaliacoes" do
// artesanou.com.br e grava numa tabela própria (avaliacoes_importadas),
// SEM misturar com as avaliações reais feitas por compradores dentro da
// Obeh (tabela "avaliacoes") nem com a nota média da loja — são mostradas
// separadamente, sempre com a origem visível (ex: "Elo7", quando o próprio
// artesanou já marca a avaliação como importada de lá).
//
// Mesma base de consentimento self-service: só o próprio dono da loja pode
// disparar isso, pra loja dele mesmo.
//
// Precisa de SUPABASE_SERVICE_ROLE_KEY.
// ============================================
const { extrairAvaliacoesDaLoja: extrairAvaliacoesArtesanou } = require('./lib/artesanou-adapter')
const { extrairAvaliacoesDaLoja: extrairAvaliacoesMinhavenda } = require('./lib/minhavenda-adapter')
const { extrairAvaliacoesDaLoja: extrairAvaliacoesAkeba } = require('./lib/akeba-adapter')

const ADAPTERS_AVALIACOES = {
  artesanou: extrairAvaliacoesArtesanou,
  minhavenda: extrairAvaliacoesMinhavenda,
  akeba: extrairAvaliacoesAkeba
}

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

function identificarPlataforma(url) {
  if (/artesanou\.com\.br/i.test(url)) return 'artesanou'
  if (/minhavenda\.com\.br/i.test(url)) return 'minhavenda'
  if (/akeba\.com\.br/i.test(url)) return 'akeba'
  return null
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

  const { userId, urlLoja, aceiteTermos } = payload

  if (!userId || !urlLoja || aceiteTermos !== true) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId, urlLoja e o aceite dos termos são obrigatórios.' }) }
  }

  const plataforma = identificarPlataforma(urlLoja)
  if (!plataforma) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Essa plataforma de origem ainda não é suportada pra importação de avaliações.' }) }
  }

  try {
    const lojas = await supabaseRequest(`lojas?user_id=eq.${userId}&select=id`)
    const loja = lojas[0]
    if (!loja) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Loja do vendedor não encontrada no Obeh.' }) }
    }

    const extrairFn = ADAPTERS_AVALIACOES[plataforma]
    const avaliacoesExtraidas = await extrairFn(urlLoja)

    if (avaliacoesExtraidas.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ total: 0, novas: 0, mensagem: 'Nenhuma avaliação encontrada na loja de origem.' }) }
    }

    // Evita duplicar se a pessoa importar de novo depois (mesma loja + mesmo
    // autor + mesmo texto = já foi importado antes)
    const jaImportadas = await supabaseRequest(`avaliacoes_importadas?loja_id=eq.${loja.id}&select=nome_autor,texto`)
    const chaveExistente = new Set(jaImportadas.map(a => `${a.nome_autor}::${a.texto}`))

    const novas = avaliacoesExtraidas.filter(a => !chaveExistente.has(`${a.nomeAutor}::${a.texto}`))

    if (novas.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ total: avaliacoesExtraidas.length, novas: 0, mensagem: 'Todas as avaliações dessa loja já tinham sido importadas.' }) }
    }

    await supabaseRequest('avaliacoes_importadas', {
      method: 'POST',
      body: JSON.stringify(novas.map(a => ({
        loja_id: loja.id,
        nome_autor: a.nomeAutor,
        texto: a.texto,
        nota: a.nota,
        origem_plataforma: plataforma,
        origem_elo7: a.origemElo7
      })))
    })

    return { statusCode: 200, body: JSON.stringify({ total: avaliacoesExtraidas.length, novas: novas.length }) }
  } catch (err) {
    console.error('Erro em importar-avaliacoes:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao importar avaliações: ' + err.message }) }
  }
}
