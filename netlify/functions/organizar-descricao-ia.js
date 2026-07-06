// =====================================
// ORGANIZA A DESCRIÇÃO DO PRODUTO VIA IA
// Mesma ideia do gerar-css-ia.js (Groq/Llama), mas em vez de gerar CSS,
// reorganiza o texto que o vendedor já escreveu — sem inventar nem remover
// informação, só deixando mais legível (parágrafos, tópicos, quebras de linha).
// =====================================

const GROQ_API_KEY = process.env.GROQ_API_KEY

const SYSTEM_PROMPT = 'Você é um assistente que organiza a redação de descrições de produtos artesanais pro marketplace Obeh. ' +
  'O vendedor vai te mandar o texto que ele já escreveu (às vezes tudo em bloco único, sem separação). ' +
  'Sua tarefa é reescrever esse MESMO texto de forma organizada — com quebras de linha separando as partes (título/nome, avisos importantes, lista de itens ou instruções, observações finais) — SEM inventar informação nova e SEM remover nenhum dado importante que o vendedor escreveu (tamanho, prazo, forma de envio, preço, condições, etc). ' +
  'Não exagere em emoji, use no máximo para separar seções se fizer sentido. Mantenha o tom do próprio vendedor. ' +
  'Responda só em português. Sempre coloque o texto final dentro de um bloco de código markdown começando com \'texto\', assim: ```texto ... ```. ' +
  'Se o vendedor pedir um ajuste depois (tipo "deixe mais curto" ou "tira a parte de X"), gere a versão COMPLETA e atualizada, não só o trecho novo.'

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido.' }) }
  }

  if (!GROQ_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Assistente de IA não configurado no servidor (GROQ_API_KEY ausente).' })
    }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) }
  }

  const mensagens = Array.isArray(body.mensagens) ? body.mensagens : []
  if (mensagens.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Nenhuma mensagem enviada.' }) }
  }

  const mensagensLimitadas = mensagens.slice(-10).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 6000)
  }))

  const payload = {
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...mensagensLimitadas],
    temperature: 0.4,
    max_tokens: 1500
  }

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const data = await resp.json()

    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || 'Erro ao chamar a IA.'
      return { statusCode: resp.status, body: JSON.stringify({ error: msg }) }
    }

    const textoResposta = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
    const match = textoResposta.match(/```texto([\s\S]*?)```/i)
    const textoOrganizado = match ? match[1].trim() : textoResposta.trim()

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resposta: textoResposta, texto: textoOrganizado })
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro interno: ' + err.message }) }
  }
}
