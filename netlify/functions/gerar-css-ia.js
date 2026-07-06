// =====================================
// GERA CSS PERSONALIZADO DA LOJA VIA IA
// Usa a API gratuita da Groq (modelo Llama) para gerar
// CSS a partir de uma conversa com o vendedor.
// =====================================

const GROQ_API_KEY = process.env.GROQ_API_KEY

const GLOSSARIO_SELETORES_LOJA = [
  { seletor: 'body', descricao: 'o fundo geral de toda a página da loja' },
  { seletor: '.loja-header-public', descricao: 'o cabeçalho/topo da loja, onde ficam a logo, o banner e o nome da loja' },
  { seletor: '.loja-avatar-public img', descricao: 'a logo/foto de perfil circular da loja' },
  { seletor: '.card', descricao: 'cada cartão de produto mostrado na vitrine da loja' },
  { seletor: '.card-media', descricao: 'a área da foto dentro do cartão de produto' },
  { seletor: '.card-cat', descricao: 'a categoria do produto, escrita pequena acima do nome dele' },
  { seletor: '.card-title', descricao: 'o nome do produto dentro do cartão' },
  { seletor: '.card-maker', descricao: 'o nome do artesão/loja mostrado dentro do cartão de produto' },
  { seletor: '.card-add', descricao: 'o botão redondo de adicionar o produto ao carrinho' },
  { seletor: '.price', descricao: 'o preço do produto' },
  { seletor: '.pasta-tile', descricao: 'cada "pasta" (categoria personalizada criada pelo vendedor), mostrada como um quadradinho clicável na loja' },
  { seletor: '.pasta-tile-img', descricao: 'a imagem de capa de cada pasta/categoria' },
  { seletor: '.pasta-tile-nome', descricao: 'o texto com o nome escrito embaixo de cada pasta/categoria' },
  { seletor: '.loja-container', descricao: 'o container/moldura geral que envolve toda a página da loja' },
  { seletor: '.loja-produtos-grid', descricao: 'a grade que organiza os cartões de produto lado a lado' },
  { seletor: '.empty-products', descricao: 'a mensagem exibida quando a loja ainda não tem nenhum produto publicado' }
]

const GLOSSARIO_SELETORES_PRODUTO = [
  { seletor: 'body', descricao: 'o fundo geral da página de UM produto específico' },
  { seletor: '.produto-container', descricao: 'o container/moldura geral que envolve toda a página do produto' },
  { seletor: '.produto-gallery .main-image', descricao: 'a moldura da foto principal do produto' },
  { seletor: '.produto-info h1', descricao: 'o nome do produto, em destaque' },
  { seletor: '.produto-info .categoria-tag', descricao: 'a etiqueta pequena com a categoria do produto' },
  { seletor: '.produto-info .price-large', descricao: 'o preço grande do produto' },
  { seletor: '.produto-info .descricao', descricao: 'o texto de descrição do produto' },
  { seletor: '.produto-actions .btn-primary', descricao: 'o botão de "Adicionar ao carrinho"' },
  { seletor: '.produto-actions .btn-outline', descricao: 'o botão de "Comprar agora"' },
  { seletor: '.produto-extra', descricao: 'o bloco de detalhes extras do produto (estoque, categoria, status)' }
]

function montarGlossarioTexto(glossario) {
  return glossario.map((g) => g.seletor + ' → ' + g.descricao).join('; ')
}

function montarSystemPrompt(contexto) {
  const ehProduto = contexto === 'produto'
  const glossario = ehProduto ? GLOSSARIO_SELETORES_PRODUTO : GLOSSARIO_SELETORES_LOJA
  const alvo = ehProduto ? 'a página de UM produto específico (não mexe na vitrine geral da loja, só na página de detalhe do produto)' : 'a página pública de uma loja de artesanato'

  return 'Você é um assistente que cria CSS personalizado para ' + alvo + ' do marketplace Obeh. ' +
    'Converse em português, de forma breve, simpática e direta. ' +
    'Sempre que gerar código, coloque o CSS completo (todas as regras juntas, incluindo as de mensagens anteriores que ainda devem valer) dentro de um bloco de código markdown com \'css no início, assim: ```css ... ```. ' +
    'Guia dos elementos que existem na página (use SOMENTE estes seletores, escritos exatamente assim, e escolha o certo com base na descrição em português — não invente outros seletores): ' + montarGlossarioTexto(glossario) + '. ' +
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
    messages: [{ role: 'system', content: montarSystemPrompt(body.contexto) }, ...mensagensLimitadas],
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
