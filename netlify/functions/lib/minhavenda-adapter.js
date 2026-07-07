// ============================================
// ADAPTER: MINHA VENDA (minhavenda.com.br)
// Extrai produtos, avaliações e dados da loja
// ============================================

const BASE_URL = 'https://minhavenda.com.br'

async function buscarHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ObehBot/1.0)' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  if (!html || html.trim().length < 100) throw new Error('Resposta vazia')
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
  const m = texto.match(/(\d+)\s*dias?/i)
  return m ? Number(m[1]) : null
}

function extrairSlugLojaDaUrl(url) {
  const m = url.match(/minhavenda\.com\.br\/loja\/([^/?]+)/i)
  return m ? m[1] : url.replace(/https?:\/\/minhavenda\.com\.br\/loja\//, '').replace(/\/$/, '')
}

// Nome da loja
async function extrairNomeLoja(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const $ = await buscarHtml(`${BASE_URL}/loja/${slug}`)
  return $('h1, .store-name, .loja-nome, .store-header h2').first().text().trim() || null
}

// Última página da paginação
function extrairUltimaPagina($) {
  let ultima = 1
  $('.pagination a, nav[aria-label="Pagination"] a, [class*="pagination"] a').each((_, el) => {
    const href = $(el).attr('href') || ''
    const m = href.match(/[?&]page=(\d+)/)
    if (m) ultima = Math.max(ultima, Number(m[1]))
  })
  return ultima
}

// Extrai cartões de produto da listagem
function extrairCartoesProdutoDoHtml($) {
  const produtos = []
  // Minha Venda: cards de produto com links /nome/pd/XXXXX
  $('a[href*="/pd/"]').each((_, el) => {
    const link = $(el)
    const url = link.attr('href')
    // Pega o texto mais próximo como título (o próprio link ou o elemento pai)
    const titulo = link.text().trim() || link.closest('div, li, article').find('h2, h3, h4, [class*="title"], [class*="nome"]').first().text().trim()
    if (!url || !url.includes('/pd/')) return
    // Evita duplicados
    if (produtos.find(p => p.url === url)) return

    const card = link.closest('div, li, article, [class*="product"], [class*="produto"]')
    const imagem = card.find('img').first().attr('src') || null
    const precoTexto = card.find('[class*="price"], [class*="preco"], strong').first().text().trim() || null
    const precoAntigoTexto = card.find('del, s, [class*="old"], [class*="antigo"]').first().text().trim() || null
    const prazoTexto = card.find('[class*="prazo"], [class*="producao"]').first().text().trim() || null

    produtos.push({
      url: url.startsWith('http') ? url : `${BASE_URL}${url}`,
      titulo: titulo || link.attr('title') || '',
      imagemThumb: imagem,
      precoAtualTexto: precoTexto,
      precoAntigoTexto,
      prazoProducaoTexto: prazoTexto,
      categoriaTexto: null
    })
  })
  return produtos
}

// Percorre todas as páginas da loja coletando cartões
async function extrairProdutosDaLoja(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const urlBase = `${BASE_URL}/loja/${slug}`

  const primeira$ = await buscarHtml(urlBase)
  const ultimaPagina = extrairUltimaPagina(primeira$)
  let produtos = extrairCartoesProdutoDoHtml(primeira$)

  for (let pagina = 2; pagina <= ultimaPagina; pagina++) {
    await esperar(300 + Math.random() * 500)
    try {
      const $ = await buscarHtml(`${urlBase}?page=${pagina}`)
      produtos = produtos.concat(extrairCartoesProdutoDoHtml($))
    } catch (err) {
      console.error(`Minha Venda: erro na página ${pagina}:`, err.message)
    }
  }

  // Remove duplicados
  const vistos = new Set()
  return produtos.filter(p => {
    if (vistos.has(p.url)) return false
    vistos.add(p.url)
    return true
  })
}

// Extrai detalhes de um produto
async function extrairDetalhesProduto(produtoUrl) {
  const $ = await buscarHtml(produtoUrl)

  const titulo = $('h1').first().text().trim() || $('[class*="product-title"], [class*="titulo"]').first().text().trim()

  // Preço: procura por "R$ X,XX" no bloco de preço
  const blocoPreco = $('[class*="price"], [class*="preco"], [class*="valor"]').first()
  const textoPreco = blocoPreco.text().trim()
  // Minha Venda mostra "R$ 2,96 R$ 3,69" (atual + antigo)
  const precos = textoPreco.match(/R\$\s*[\d,.]+/g) || []
  const precoAtual = precos.length >= 1 ? parsePrecoBRL(precos[0]) : null
  const precoAntigo = precos.length >= 2 ? parsePrecoBRL(precos[1]) : null

  // Prazo de produção
  const prazoEl = $('[class*="prazo"], [class*="producao"], *:contains("Prazo de produção")').first()
  const prazoTexto = prazoEl.text().trim() || ''
  const prazoProducaoDias = extrairDiasProducao(prazoTexto)

  // Categoria (breadcrumb)
  const categoria = $('.breadcrumb a, [class*="breadcrumb"] a').last().text().trim() || null

  // Coleção/pasta
  const pastaOrigem = $('[class*="colecao"], [class*="conjunto"], [class*="collection"] a').first().text().trim() || null

  // Descrição
  const descricao = $('[class*="desc"], [class*="detalhes"], #product-desc, .product-description').first().text().trim() || null

  // Imagens
  const imagens = []
  $('img[src*="/images/"], img[data-zoom]').each((_, el) => {
    const src = $(el).attr('data-zoom') || $(el).attr('src')
    if (src && !imagens.includes(src) && !src.includes('thumb') && !src.includes('logo') && !src.includes('avatar')) {
      imagens.push(src.startsWith('http') ? src : `${BASE_URL}${src}`)
    }
  })

  // Sob encomenda
  const sobEncomenda = $('*:contains("Prazo de produção"), *:contains("sob encomenda")').length > 0 || Boolean(prazoProducaoDias)

  // Dimensões
  let altura = null, largura = null, comprimento = null
  const textoDims = $('*:contains("Altura"), *:contains("Largura"), *:contains("Comprimento")').text()
  const mAltura = textoDims.match(/Altura:\s*([\d,.]+)/)
  const mLargura = textoDims.match(/Largura:\s*([\d,.]+)/)
  const mComprimento = textoDims.match(/Comprimento:\s*([\d,.]+)/)
  if (mAltura) altura = parseFloat(mAltura[1].replace(',', '.'))
  if (mLargura) largura = parseFloat(mLargura[1].replace(',', '.'))
  if (mComprimento) comprimento = parseFloat(mComprimento[1].replace(',', '.'))

  return {
    urlOrigem: produtoUrl,
    titulo: titulo || null,
    descricao,
    precoAtual,
    precoAntigo,
    categoriaTexto: categoria,
    pastaOrigemTexto: pastaOrigem,
    imagens: imagens.slice(0, 4),
    sobEncomenda: sobEncomenda || Boolean(prazoProducaoDias),
    prazoProducaoDias,
    altura_cm: altura || null,
    largura_cm: largura || null,
    comprimento_cm: comprimento || null
  }
}

// Extrai avaliações
async function extrairAvaliacoesDaLoja(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const avaliacoes = []

  try {
    const $ = await buscarHtml(`${BASE_URL}/loja/${slug}/avaliacoes`)
    $('[class*="rating"], [class*="avaliacao"], [class*="review"], .store-rating-card').each((_, el) => {
      const card = $(el)
      const nome = card.find('[class*="nome"], [class*="name"], [class*="author"], strong').first().text().trim()
      const texto = card.find('[class*="texto"], [class*="comment"], [class*="content"], p').first().text().trim()
      const notaEl = card.find('[class*="star"], [class*="nota"], .fa-star')
      let nota = null
      if (notaEl.length > 0) {
        const style = notaEl.attr('style') || ''
        const widthMatch = style.match(/width:\s*(\d+)%/) || style.match(/width:\s*(\d+)/)
        if (widthMatch) nota = Math.round(Number(widthMatch[1]) / 20)
        else nota = notaEl.length
      }

      if (nome && texto) {
        avaliacoes.push({ nome_autor: nome, texto, nota, origem_plataforma: 'minhavenda', origem_elo7: false })
      }
    })
  } catch (err) {
    console.error('Minha Venda: erro ao extrair avaliações:', err.message)
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
