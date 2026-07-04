// ============================================
// FUNÇÃO NETLIFY - CALCULAR FRETE
// Recebe um CEP de destino e a lista de produtos do carrinho e devolve
// uma estimativa de frete pra cada loja envolvida (agrupando os produtos
// por vendedor, já que cada loja despacha separadamente).
//
// Ordem de prioridade pra cada loja:
//   1) SuperFrete, se a loja tiver um token pessoal cadastrado (lojas.superfrete_token)
//   2) Correios (API oficial), se o servidor tiver credenciais configuradas
//   3) Frete manual por região (tabela fretes_regiao), se a loja tiver faixas cadastradas
//   4) Estimativa aproximada baseada só no peso, como último recurso
//
// Precisa das variáveis de ambiente (todas opcionais — sem elas, usa os
// fallbacks abaixo):
//   SUPERFRETE_BASE_URL        - https://api.superfrete.com (padrão) ou https://sandbox.superfrete.com
//   CORREIOS_USUARIO           - usuário de acesso à API dos Correios
//   CORREIOS_CODIGO_ACESSO     - código de acesso (senha) da API
//   CORREIOS_NUMERO_CARTAO     - número do cartão de postagem
//   CORREIOS_CONTRATO          - número do contrato
//   CORREIOS_DR                - código da regional (DR) do contrato
//
// Também precisa da SUPABASE_SERVICE_ROLE_KEY (chave "service_role" do
// Supabase) pra buscar produtos e lojas.
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const CORREIOS_USUARIO = process.env.CORREIOS_USUARIO
const CORREIOS_CODIGO_ACESSO = process.env.CORREIOS_CODIGO_ACESSO
const CORREIOS_NUMERO_CARTAO = process.env.CORREIOS_NUMERO_CARTAO
const CORREIOS_CONTRATO = process.env.CORREIOS_CONTRATO
const CORREIOS_DR = process.env.CORREIOS_DR

const SUPERFRETE_BASE_URL = process.env.SUPERFRETE_BASE_URL || 'https://api.superfrete.com'
const SUPERFRETE_CONTATO = process.env.SUPERFRETE_CONTATO || 'contato@obeh.com.br'

// Faixas de CEP (2 primeiros dígitos) por região, pra usar o frete manual por região
// quando não há SuperFrete nem Correios configurados.
function regiaoPorCep(cepDestino) {
  const prefixo = Number(String(cepDestino).slice(0, 2))
  if (prefixo <= 39) return 'Sudeste' // SP, RJ, ES, MG
  if (prefixo <= 65) return 'Nordeste' // BA, SE, PE, AL, PB, RN, CE, PI, MA
  if (prefixo <= 69) return 'Norte' // PA, AP, AM, RR, AC
  if (prefixo === 77) return 'Norte' // TO
  if (prefixo <= 76 || prefixo === 78 || prefixo === 79) return 'Centro-Oeste' // DF, GO, MT, MS
  return 'Sul' // PR, SC, RS
}

// Códigos de serviço dos Correios (tabela pública, não muda por contrato)
const SERVICOS = [
  { codigo: '03298', nome: 'PAC' },
  { codigo: '03220', nome: 'SEDEX' }
]

let tokenCache = { valor: null, expiraEm: 0 }

async function supabaseRequest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res.json()
}

async function getTokenCorreios() {
  const agora = Date.now()
  if (tokenCache.valor && tokenCache.expiraEm > agora) {
    return tokenCache.valor
  }

  const auth = Buffer.from(`${CORREIOS_USUARIO}:${CORREIOS_CODIGO_ACESSO}`).toString('base64')
  const res = await fetch('https://api.correios.com.br/token/v1/autentica/cartaopostagem', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      numero: CORREIOS_NUMERO_CARTAO,
      contrato: CORREIOS_CONTRATO,
      dr: Number(CORREIOS_DR)
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Falha ao autenticar na API dos Correios (${res.status}): ${text}`)
  }

  const data = await res.json()
  tokenCache = {
    valor: data.token,
    // Renova um pouco antes de expirar (a API costuma dar tokens de ~1h)
    expiraEm: agora + 45 * 60 * 1000
  }
  return data.token
}

function calcularEstimativaAproximada(pesoTotalKg) {
  const base = 15
  const porKgExtra = 4
  const pesoExtra = Math.max(0, pesoTotalKg - 1)
  const valor = Math.round((base + pesoExtra * porKgExtra) * 100) / 100

  return {
    estimativaAproximada: true,
    opcoes: [
      { servico: 'estimativa', nome: 'Frete estimado', preco: valor, prazoDias: null }
    ]
  }
}

async function calcularFreteReal(cepOrigem, cepDestino, pesoTotalKg, dimensoes) {
  const token = await getTokenCorreios()
  const opcoes = []

  for (const servico of SERVICOS) {
    const params = new URLSearchParams({
      cepOrigem: cepOrigem.replace(/\D/g, ''),
      cepDestino: cepDestino.replace(/\D/g, ''),
      psObjeto: String(pesoTotalKg),
      tpObjeto: '2',
      comprimento: String(dimensoes.comprimento),
      largura: String(dimensoes.largura),
      altura: String(dimensoes.altura)
    })

    const res = await fetch(`https://api.correios.com.br/preco/v1/nacional/${servico.codigo}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (!res.ok) continue

    const data = await res.json()
    const preco = Number(String(data.pcFinal || data.preco || '0').replace(',', '.'))
    if (!preco) continue

    opcoes.push({
      servico: servico.codigo,
      nome: servico.nome,
      preco,
      prazoDias: data.prazoEntrega ? Number(data.prazoEntrega) : null
    })
  }

  if (opcoes.length === 0) {
    throw new Error('Nenhum serviço dos Correios retornou preço.')
  }

  return { estimativaAproximada: false, opcoes }
}

async function calcularFreteSuperFrete(token, cepOrigem, cepDestino, produtosGrupo) {
  const res = await fetch(`${SUPERFRETE_BASE_URL}/api/v0/calculator`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': `Obeh Marketplace (${SUPERFRETE_CONTATO})`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: { postal_code: cepOrigem.replace(/\D/g, '') },
      to: { postal_code: cepDestino.replace(/\D/g, '') },
      products: produtosGrupo.map(p => ({
        quantity: p.quantidade,
        height: p.altura,
        length: p.comprimento,
        width: p.largura,
        weight: p.peso
      }))
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`SuperFrete respondeu ${res.status}: ${text}`)
  }

  const data = await res.json()
  const lista = Array.isArray(data) ? data : (data.opcoes || data.options || [])
  const opcoes = lista
    .filter(o => !o.error && (o.price || o.custom_price))
    .map(o => ({
      servico: String(o.id ?? o.name ?? 'superfrete'),
      nome: o.name || 'Frete',
      preco: Number(o.custom_price ?? o.price),
      prazoDias: o.delivery_time ? Number(o.delivery_time) : (o.delivery_range?.max ? Number(o.delivery_range.max) : null)
    }))

  if (opcoes.length === 0) {
    throw new Error('SuperFrete não retornou nenhuma opção válida.')
  }

  return { estimativaAproximada: false, opcoes }
}

function calcularFreteManualPorRegiao(faixas, cepDestino, quantidadeTotal) {
  const regiao = regiaoPorCep(cepDestino)
  const faixa = faixas.find(f =>
    f.regiao === regiao &&
    quantidadeTotal >= f.quantidade_min &&
    quantidadeTotal <= f.quantidade_max
  )
  if (!faixa) return null

  const preco = faixa.frete_gratis ? 0 : Number(faixa.preco)
  return {
    estimativaAproximada: false,
    opcoes: [
      { servico: 'manual', nome: faixa.frete_gratis ? 'Frete grátis' : 'Frete', preco, prazoDias: null }
    ]
  }
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

  const { cepDestino, itens } = payload
  const cepLimpo = String(cepDestino || '').replace(/\D/g, '')

  if (cepLimpo.length !== 8 || !Array.isArray(itens) || itens.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'cepDestino (8 dígitos) e itens são obrigatórios.' }) }
  }

  try {
    const ids = itens.map(i => i.produtoId).filter(Boolean)
    const produtos = await supabaseRequest(
      `produtos?id=in.(${ids.join(',')})&select=id,loja_id,peso_kg,altura_cm,largura_cm,comprimento_cm,lojas(id,nome_loja,cep_origem,superfrete_token)`
    )

    // Agrupa os itens por loja, já que cada vendedor despacha separadamente
    const porLoja = {}
    for (const item of itens) {
      const produto = produtos.find(p => p.id === item.produtoId)
      if (!produto) continue
      const lojaId = produto.loja_id
      if (!porLoja[lojaId]) {
        porLoja[lojaId] = {
          lojaId,
          nomeLoja: produto.lojas?.nome_loja || 'Loja',
          cepOrigem: produto.lojas?.cep_origem || null,
          superfreteToken: produto.lojas?.superfrete_token || null,
          quantidadeTotal: 0,
          pesoTotalKg: 0,
          altura: 10,
          largura: 15,
          comprimento: 20,
          itensDetalhados: []
        }
      }
      const grupo = porLoja[lojaId]
      const quantidade = Number(item.quantidade || 1)
      grupo.quantidadeTotal += quantidade
      grupo.pesoTotalKg += Number(produto.peso_kg || 0.3) * quantidade
      grupo.altura = Math.max(grupo.altura, Number(produto.altura_cm || 10))
      grupo.largura = Math.max(grupo.largura, Number(produto.largura_cm || 15))
      grupo.comprimento = Math.max(grupo.comprimento, Number(produto.comprimento_cm || 20))
      grupo.itensDetalhados.push({
        quantidade,
        peso: Number(produto.peso_kg || 0.3),
        altura: Number(produto.altura_cm || 10),
        largura: Number(produto.largura_cm || 15),
        comprimento: Number(produto.comprimento_cm || 20)
      })
    }

    const credenciaisCorreiosOk = CORREIOS_USUARIO && CORREIOS_CODIGO_ACESSO && CORREIOS_NUMERO_CARTAO && CORREIOS_CONTRATO && CORREIOS_DR

    const lojaIdsComGrupo = Object.keys(porLoja)
    const todasFaixas = lojaIdsComGrupo.length > 0
      ? await supabaseRequest(`fretes_regiao?loja_id=in.(${lojaIdsComGrupo.join(',')})&select=*`)
      : []

    const fretes = []
    for (const grupo of Object.values(porLoja)) {
      let resultado = null

      if (grupo.superfreteToken && grupo.cepOrigem) {
        try {
          resultado = await calcularFreteSuperFrete(grupo.superfreteToken, grupo.cepOrigem, cepLimpo, grupo.itensDetalhados)
        } catch (err) {
          console.error('Falha ao calcular frete via SuperFrete, tentando próxima opção:', err.message)
        }
      }

      if (!resultado && credenciaisCorreiosOk && grupo.cepOrigem) {
        try {
          resultado = await calcularFreteReal(grupo.cepOrigem, cepLimpo, grupo.pesoTotalKg, {
            altura: grupo.altura,
            largura: grupo.largura,
            comprimento: grupo.comprimento
          })
        } catch (err) {
          console.error('Falha ao calcular frete real, tentando próxima opção:', err.message)
        }
      }

      if (!resultado) {
        const faixasDaLoja = todasFaixas.filter(f => f.loja_id === grupo.lojaId)
        resultado = calcularFreteManualPorRegiao(faixasDaLoja, cepLimpo, grupo.quantidadeTotal)
      }

      if (!resultado) {
        resultado = calcularEstimativaAproximada(grupo.pesoTotalKg)
      }

      fretes.push({
        lojaId: grupo.lojaId,
        nomeLoja: grupo.nomeLoja,
        ...resultado
      })
    }

    return { statusCode: 200, body: JSON.stringify({ fretes }) }
  } catch (err) {
    console.error('Erro em calcular-frete:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao calcular o frete.' }) }
  }
}
