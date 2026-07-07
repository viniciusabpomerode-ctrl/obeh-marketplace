// ============================================
// ADAPTER: ARTESANOU.COM.BR
// Extrai dados PÚBLICOS de uma loja no artesanou.com.br pra importação
// self-service (o próprio vendedor autoriza a extração da própria loja
// dele — ver o termo de consentimento em importar-loja.js).
//
// Implementa o contrato SourceAdapter (ver source-adapter.js):
//   extrairCategorias(lojaSlug)
//   extrairProdutosDaLoja(lojaSlug)
//   extrairDetalhesProduto(produtoUrl)
//
// Os seletores abaixo foram conferidos direto no HTML real do site (não
// são um chute) — mas por natureza um scraper é frágil: se o artesanou
// mudar o layout, isso para de funcionar e precisa ser atualizado.
// ============================================
const cheerio = require('cheerio')

const PLATAFORMA = 'artesanou'
const BASE_URL = 'https://artesanou.com.br'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Campos que esse adapter é capaz de extrair de fato — usado pelo
// orquestrador pra não tentar heurística em campos que essa origem nunca vai ter.
const camposSuportados = [
  'titulo', 'descricao', 'precoAtual', 'precoAntigo', 'categoria',
  'pastaOrigem', 'imagens', 'sobEncomenda', 'prazoProducaoDias'
]

async function buscarHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    throw new Error(`Falha ao acessar ${url} (${res.status})`)
  }
  const html = await res.text()
  if (!html || html.trim().length < 100) throw new Error(`Resposta vazia de ${url}`)
  return cheerio.load(html)
}

function extrairSlugLojaDaUrl(urlOuSlug) {
  const match = String(urlOuSlug).match(/\/loja\/([^/?]+)/)
  return match ? match[1] : String(urlOuSlug).replace(/^https?:\/\/[^/]+\/?/, '').replace(/\/$/, '')
}

// Lê os "cartões" de pasta/categoria mostrados na página da loja.
function extrairCategoriasDoHtml($) {
  const categorias = []
  $('.product-folder__link').each((_, el) => {
    const link = $(el)
    const href = link.attr('href')
    const nome = link.attr('title') || link.find('.product-folder__label').text().trim()
    if (href && nome) {
      categorias.push({ nome: nome.trim(), url: href })
    }
  })
  return categorias
}

// Extrai os cartões de produto de UMA página de listagem (loja ou pasta)
function extrairCartoesProdutoDoHtml($) {
  const produtos = []
  $('.product-default').each((_, el) => {
    const card = $(el)
    const link = card.find('.product-title a').first()
    const url = link.attr('href')
    const titulo = link.text().trim()
    if (!url || !titulo) return

    const imagem = card.find('.image-container img').attr('src') || null
    const precoTexto = card.find('.price-box .price .theme-color').first().text().trim()
    const precoAntigoTexto = card.find('.price-box .price del').first().text().trim() || null
    const prazoTexto = card.find('.product-card-tag--production').first().text().trim() || null
    const categoriaTexto = card.find('.category-list').first().text().trim() || null

    produtos.push({
      url,
      titulo,
      imagemThumb: imagem,
      precoAtualTexto: precoTexto,
      precoAntigoTexto,
      prazoProducaoTexto: prazoTexto,
      categoriaTexto
    })
  })
  return produtos
}

// Descobre o número da última página a partir dos links de paginação
function extrairUltimaPagina($) {
  let ultima = 1
  $('.pagination a[href*="page="]').each((_, el) => {
    const href = $(el).attr('href') || ''
    const m = href.match(/page=(\d+)/)
    if (m) ultima = Math.max(ultima, Number(m[1]))
  })
  return ultima
}

function parsePrecoBRL(texto) {
  if (!texto) return null
  // Remove tudo que não for dígito ou vírgula, depois troca vírgula (decimal BR) por ponto
  const limpo = texto.replace(/[^\d,]/g, '').replace(/,/g, '.')
  const valor = Number(limpo)
  return Number.isFinite(valor) && valor > 0 ? valor : null
}

function extrairDiasProducao(texto) {
  if (!texto) return null
  const m = texto.match(/(\d+)\s*dias?/i)
  return m ? Number(m[1]) : null
}

async function extrairCategorias(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const $ = await buscarHtml(`${BASE_URL}/loja/${slug}`)
  return extrairCategoriasDoHtml($)
}

// Nome de exibição da loja de origem (ex: "CK Atelier") — usado só pra
// mostrar no resumo da importação pro vendedor, não é gravado como dado
// oficial de nenhum produto.
async function extrairNomeLoja(lojaSlugOuUrl) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const $ = await buscarHtml(`${BASE_URL}/loja/${slug}`)
  return $('h1.store-page__title').first().text().trim() || null
}

// Percorre todas as páginas da loja (ou de uma pasta específica, se
// pastaUrl for informada) coletando os cartões de produto.
async function extrairProdutosDaLoja(lojaSlugOuUrl, pastaUrl, aoBuscarPagina) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const urlBase = pastaUrl || `${BASE_URL}/loja/${slug}`

  const primeira$ = await buscarHtml(urlBase)
  const ultimaPagina = extrairUltimaPagina(primeira$)
  let produtos = extrairCartoesProdutoDoHtml(primeira$)

  for (let pagina = 2; pagina <= ultimaPagina; pagina++) {
    if (aoBuscarPagina) await aoBuscarPagina(pagina, ultimaPagina)
    await esperar(300 + Math.random() * 500) // pausa educada entre páginas
    const separador = urlBase.includes('?') ? '&' : '?'
    const $ = await buscarHtml(`${urlBase}${separador}page=${pagina}`)
    produtos = produtos.concat(extrairCartoesProdutoDoHtml($))
  }

  // Cada produto pode aparecer em mais de uma pasta — remove duplicados pela URL
  const vistos = new Set()
  return produtos.filter(p => {
    if (vistos.has(p.url)) return false
    vistos.add(p.url)
    return true
  })
}

async function extrairDetalhesProduto(produtoUrl) {
  const $ = await buscarHtml(produtoUrl)

  const titulo = $('h1.product-title').first().text().trim()

  const precoAtual = parsePrecoBRL($('.product-price-block .new-price').first().text())
  const oldPriceEl = $('.product-price-block .old-price').first()
  const precoAntigo = oldPriceEl.hasClass('d-none') ? null : parsePrecoBRL(oldPriceEl.text())

  const sobEncomendaVisivel = $('.product-feature-tag--encomenda').length > 0 &&
    !$('.product-feature-tag--encomenda').hasClass('d-none')
  const prazoTextoBadge = $('.product-info-badge-item--production strong').first().text().trim()
  const prazoTextoBloco = $('.product-production-info__text span').first().text().trim()
  const prazoProducaoDias = extrairDiasProducao(prazoTextoBadge) || extrairDiasProducao(prazoTextoBloco)

  const categoria = $('a.product-category').first().text().trim() || null
  const pastaOrigem = $('a.product-folder-link').first().text().trim() || null

  const descricao = $('#product-desc-content .product-desc-content').first().text().trim().replace(/\n{3,}/g, '\n\n') || null

  const imagens = []
  $('img.product-single-image').each((_, el) => {
    const src = $(el).attr('data-zoom-image') || $(el).attr('src')
    if (src && !imagens.includes(src)) imagens.push(src)
  })

  return {
    urlOrigem: produtoUrl,
    titulo: titulo || null,
    descricao,
    precoAtual,
    precoAntigo,
    categoriaTexto: categoria,
    pastaOrigemTexto: pastaOrigem,
    imagens: imagens.slice(0, 4), // mesmo limite de 4 fotos do formulário do Obeh
    // sob encomenda é considerado true tanto pela badge específica quanto
    // por ter um prazo de produção divulgado — a origem às vezes só mostra
    // o prazo sem marcar a badge separada
    sobEncomenda: sobEncomendaVisivel || Boolean(prazoProducaoDias),
    prazoProducaoDias
  }
}

// Extrai os cartões de avaliação da página pública "/loja/<slug>/avaliacoes".
// Confirmado no HTML real: cada avaliação é um .store-rating-card com nome
// do autor, texto e a nota como barra de largura em % (100% = 5 estrelas).
// Muitas dessas avaliações já são identificadas ali mesmo como importadas do
// Elo7 (.store-rating-elo7-tag) — mantemos essa origem visível ao importar,
// nunca escondemos de onde veio.
function extrairAvaliacoesDoHtml($) {
  const avaliacoes = []
  $('.store-rating-card').each((_, el) => {
    const card = $(el)
    const nomeAutor = card.find('.store-rating-card__name').first().text().trim()
    const texto = card.find('.store-rating-card__text').first().text().trim()
    if (!nomeAutor || !texto) return

    const estiloNota = card.find('.ratings').first().attr('style') || ''
    const matchNota = estiloNota.match(/width:\s*(\d+(?:\.\d+)?)%/)
    const nota = matchNota ? Math.max(1, Math.min(5, Math.round((Number(matchNota[1]) / 100) * 5))) : null

    const origemElo7 = card.find('.store-rating-elo7-tag').length > 0

    avaliacoes.push({ nomeAutor, texto, nota, origemElo7 })
  })
  return avaliacoes
}

async function extrairAvaliacoesDaLoja(lojaSlugOuUrl, aoBuscarPagina) {
  const slug = extrairSlugLojaDaUrl(lojaSlugOuUrl)
  const urlBase = `${BASE_URL}/loja/${slug}/avaliacoes`

  const primeira$ = await buscarHtml(urlBase)
  const ultimaPagina = extrairUltimaPagina(primeira$)
  let avaliacoes = extrairAvaliacoesDoHtml(primeira$)

  for (let pagina = 2; pagina <= ultimaPagina; pagina++) {
    if (aoBuscarPagina) await aoBuscarPagina(pagina, ultimaPagina)
    await esperar(300 + Math.random() * 500) // pausa educada entre páginas
    const $ = await buscarHtml(`${urlBase}?page=${pagina}`)
    avaliacoes = avaliacoes.concat(extrairAvaliacoesDoHtml($))
  }

  return avaliacoes
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  plataforma: PLATAFORMA,
  camposSuportados,
  extrairCategorias,
  extrairNomeLoja,
  extrairProdutosDaLoja,
  extrairDetalhesProduto,
  extrairAvaliacoesDaLoja,
  parsePrecoBRL,
  extrairDiasProducao
}
