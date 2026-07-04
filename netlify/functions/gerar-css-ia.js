null// =====================================
// GERA CSS PERSONALIZADO DA LOJA VIA IA
// Usa a API gratuita da Groq (modelo Llama) para gerar
// CSS a partir de uma conversa com o vendedor.
// =====================================

const GROQ_API_KEY = process.env.GROQ_API_KEY

const SELETORES_PERMITIDOS = [
  'body',
  '.loja-header-public',
  '.loja-avatar-public img',
  '.card',
  '.card-media',
  '.card-cat',
  '.card-title',
  '.card-maker',
  '.card-add',
  '.price',
  '.pasta-tile',
  '.pasta-tile-img',
  '.pasta-tile-nome',
  '.loja-container',
  '.loja-produtos-grid',
  '.empty-products'
]

function montarSystemPrompt() {
  return 'Você é um assistente que cria CSS personalizado para a página pública de uma loja de artesanato do marketplace Obeh. ' +
    'Converse em português, de forma breve, simpática e direta. ' +
    'Sempre que gerar código, coloque o CSS completo (todas as regras juntas, incluindo as de mensagens anteriores que ainda devem valer) dentro de um bloco de código markdown com \'css no início, assim: ```css ... ```. ' +
    'Use apenas estes seletores, que já existem na página (não invente outros): ' + SELETORES_PERMITIDOS.join(', ') + '. ' +
    'Nunca use JavaScript, apenas CSS puro. Não inclua as tags <style> ou <script>, apenas as regras CSS. ' +
    'Se o pedido do vendedor for vago (tipo só uma cor ou um clima), use sua criatividade dentro de um estilo artesanal/rústico/acolhedor. ' +
    'Se o vendedor pedir um ajuste depois de já ter gerado um CSS, gere a versão COMPLETA e atualizada (não só o trecho novo).'
}

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

  const mensagensLimitadas = mensagens.slice(-16).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 4000)
  }))

  const payload = {
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: montarSystemPrompt() }, ...mensagensLimitadas],
    temperature: 0.7,
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
    const match = textoResposta.match(/```css([\s\S]*?)```/i)
    const css = match ? match[1].trim() : ''

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resposta: textoResposta, css })
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro interno: ' + err.message }) }
  }
}
