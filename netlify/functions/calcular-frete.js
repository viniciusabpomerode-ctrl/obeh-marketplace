// ============================================
// FUNÇÃO NETLIFY - CALCULAR FRETE (Correios)
// Recebe um CEP de destino e a lista de produtos do carrinho e devolve
// uma estimativa de frete pra cada loja envolvida (agrupando os produtos
// por vendedor, já que cada loja despacha separadamente).
//
// Se a loja não tiver CEP de origem cadastrado, ou se as credenciais da
// API dos Correios não estiverem configuradas no servidor, a função cai
// num cálculo aproximado (baseado só no peso) pra não travar o checkout
// — assim que as credenciais forem cadastradas, o cálculo passa a usar
// os preços reais dos Correios automaticamente.
//
// Precisa das variáveis de ambiente (todas opcionais — sem elas, usa a
// estimativa aproximada):
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
      `produtos?id=in.(${ids.join(',')})&select=id,loja_id,peso_kg,altura_cm,largura_cm,comprimento_cm,lojas(id,nome_loja,cep_origem)`
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
          pesoTotalKg: 0,
          altura: 10,
          largura: 15,
          comprimento: 20
        }
      }
      const grupo = porLoja[lojaId]
      grupo.pesoTotalKg += Number(produto.peso_kg || 0.3) * Number(item.quantidade || 1)
      grupo.altura = Math.max(grupo.altura, Number(produto.altura_cm || 10))
      grupo.largura = Math.max(grupo.largura, Number(produto.largura_cm || 15))
      grupo.comprimento = Math.max(grupo.comprimento, Number(produto.comprimento_cm || 20))
    }

    const credenciaisOk = CORREIOS_USUARIO && CORREIOS_CODIGO_ACESSO && CORREIOS_NUMERO_CARTAO && CORREIOS_CONTRATO && CORREIOS_DR

    const fretes = []
    for (const grupo of Object.values(porLoja)) {
      let resultado
      if (!credenciaisOk || !grupo.cepOrigem) {
        resultado = calcularEstimativaAproximada(grupo.pesoTotalKg)
      } else {
        try {
          resultado = await calcularFreteReal(grupo.cepOrigem, cepLimpo, grupo.pesoTotalKg, {
            altura: grupo.altura,
            largura: grupo.largura,
            comprimento: grupo.comprimento
          })
        } catch (err) {
          console.error('Falha ao calcular frete real, usando estimativa aproximada:', err.message)
          resultado = calcularEstimativaAproximada(grupo.pesoTotalKg)
        }
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
