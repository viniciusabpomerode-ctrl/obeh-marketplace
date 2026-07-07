// ============================================
// ADAPTER: AKEBA (akeba.com.br)
// Extrai produtos, avaliações e dados da loja
// ============================================

const BASE_URL = 'https://www.akeba.com.br'

async function buscarHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ObehBot/1.0)' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  if (!html || html.trim().length < 100) throw new Error('Resposta vazia ou muito curta')
  return require('cheerio').load(html)
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parsePrecoBRL(texto) {
  if (!texto) return null
  const limpo = texto.replace(/[^\d,]/g, '').replace(/,/g, '.')
  const valor = Number(limpo)
  return Number.isFinite(valor) && valor > 0 ? valor : null
}

function extrairDiasProducao(texto) {
  if (!texto) return null
  // "pronto em ate 5 dias", "Prazo de produção: 5 dias úteis"
  const m = texto.match(/(\d+)\s*dias?/i)
  return m ? Number(m[1]) : null
}

function extrairSlugLojaDaUrl(url) {
  const m = url.match(/akeba\.com\.br\/loja\/([^/?]+)/i)
  return m ? m[1] : url.replace(/https?:\/\/www\.akeba\.com\.br\/loja\//, '').replace(/\/$/, '')
}

// Nome da loja
async function extrairNomeLoja(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const $ = await buscarHtml(`${BASE_URL}/loja/${slug}`)
  return $('h1').first().text().trim() || null
}

// Última página
function extrairUltimaPagina($) {
  let ultima = 1
  $('nav a[href*="pagina="], [class*="pagination"] a, button[class*="page"]').each((_, el) => {
    const href = $(el).attr('href') || ''
    const texto = $(el).text().trim()
    const n = Number(texto)
    if (n > 0) ultima = Math.max(ultima, n)
    const m = href.match(/pagina=(\d+)/)
    if (m) ultima = Math.max(ultima, Number(m[1]))
  })
  return ultima
}

// Cartões de produto na listagem
function extrairCartoesProdutoDoHtml($) {
  const produtos = []
  // Akeba: links de produto são /produto/nome-XXXXXX
  $('a[href*="/produto/"]').each((_, el) => {
    const link = $(el)
    const url = link.attr('href')
    if (!url || !url.includes('/produto/') || url.includes('/loja/')) return
    if (produtos.find(p => p.url === url)) return

    const card = link.closest('div, li, article, a, [class*="product"], [class*="card"]')
    const titulo = card.find('h2, h3, [class*="title"], [class*="name"]').first().text().trim() || link.text().trim()
    const imagem = card.find('img').first().attr('src') || null
    // Akeba: preço tipo "R$ 6,99"
    const precoTexto = card.find('[class*="price"], [class*="amount"], strong').first().text().trim() || null
    const prazoTexto = card.find('*:contains("pronto em"), *:contains("dias")').first().text().trim() || null

    produtos.push({
      url: url.startsWith('http') ? url : `${BASE_URL}${url}`,
      titulo,
      imagemThumb: imagem,
      precoAtualTexto: precoTexto,
      precoAntigoTexto: null, // Akeba não mostra preço antigo na listagem
      prazoProducaoTexto: prazoTexto,
      categoriaTexto: null
    })
  })
  return produtos
}

// Percorre todas as páginas
async function extrairProdutosDaLoja(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const urlBase = `${BASE_URL}/loja/${slug}`

  const primeira$ = await buscarHtml(urlBase)
  const ultimaPagina = extrairUltimaPagina(primeira$)
  let produtos = extrairCartoesProdutoDoHtml(primeira$)

  for (let pagina = 2; pagina <= ultimaPagina; pagina++) {
    await esperar(300 + Math.random() * 500)
    try {
      const $ = await buscarHtml(`${urlBase}?pagina=${pagina}`)
      produtos = produtos.concat(extrairCartoesProdutoDoHtml($))
    } catch (err) {
      console.error(`Akeba: erro na página ${pagina}:`, err.message)
    }
  }

  const vistos = new Set()
  return produtos.filter(p => {
    if (vistos.has(p.url)) return false
    vistos.add(p.url)
    return true
  })
}

// Detalhes do produto
async function extrairDetalhesProduto(produtoUrl) {
  const $ = await buscarHtml(produtoUrl)

  const titulo = $('h1').first().text().trim()

  // Preço: "R$ 8,99"
  const precoEl = $('[class*="price"], [class*="amount"], [class*="valor"], .product-price').first()
  const precoAtual = parsePrecoBRL(precoEl.text())
  const precoAntigo = null // Akeba não tem preço riscado visível

  // Categoria
  const categoria = $('[class*="category"], [class*="categoria"], a[href*="/categorias/"]').first().text().trim() || null

  // Descrição
  const descricao = $('[class*="desc"], [class*="description"], .product-description, #product-description').first().text().trim() || null

  // Prazo: "Prazo de produção: 5 dias úteis" ou "pronto em ate X dias"
  const textoPrazo = $('*:contains("Prazo de produção"), *:contains("pronto em"), *:contains("dias")').text()
  const prazoProducaoDias = extrairDiasProducao(textoPrazo)

  // Sob encomenda
  const sobEncomenda = $('*:contains("Feito sob encomenda"), *:contains("sob encomenda")').length > 0 || Boolean(prazoProducaoDias)

  // Imagens do produto
  const imagens = []
  // Akeba usa img.akeba.com.br para imagens de produto
  $('img[src*="products/"], img[src*="img.akeba"]').each((_, el) => {
    let src = $(el).attr('src')
    if (!src) return
    // Pega a versão full size (remove _thumb)
    src = src.replace(/_thumb\.(webp|jpg|png)/i, '.$1')
    if (!imagens.includes(src) && !src.includes('_thumb')) {
      imagens.push(src)
    }
  })

  return {
    urlOrigem: produtoUrl,
    titulo: titulo || null,
    descricao,
    precoAtual,
    precoAntigo,
    categoriaTexto: categoria,
    pastaOrigemTexto: null,
    imagens: imagens.slice(0, 4),
    sobEncomenda,
    prazoProducaoDias,
    altura_cm: null,
    largura_cm: null,
    comprimento_cm: null
  }
}

// Avaliações
async function extrairAvaliacoesDaLoja(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const avaliacoes = []

  try {
    const $ = await buscarHtml(`${BASE_URL}/loja/${slug}`)
    // Akeba pode ter avaliações na própria página da loja
    $('[class*="review"], [class*="rating"], [class*="avaliacao"]').each((_, el) => {
      const card = $(el)
      const nome = card.find('[class*="name"], [class*="author"], strong').first().text().trim()
      const texto = card.find('p, [class*="text"], [class*="comment"]').first().text().trim()
      const estrelas = card.find('[class*="star"], .fa-star, svg').length || null

      if (nome && texto) {
        avaliacoes.push({ nome_autor: nome, texto, nota: estrelas, origem_plataforma: 'akeba', origem_elo7: false })
      }
    })
  } catch (err) {
    console.error('Akeba: erro ao extrair avaliações:', err.message)
  }

  return avaliacoes
}

module.exports = {
  extrairNomeLoja,
  extrairProdutosDaLoja,
  extrairDetalhesProduto,
  extrairAvaliacoesDaLoja,
  parsePrecoBRL,
  extrairDiasProducao
}
