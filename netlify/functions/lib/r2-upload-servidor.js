// ============================================
// UPLOAD SERVIDOR->R2 (usado pela importação de loja)
// Baixa uma imagem de uma URL de origem e sobe direto pro mesmo bucket R2
// que o resto do site já usa (js/upload-r2.js faz a versão client-side
// disso; aqui é a versão server-side, sem precisar de URL pré-assinada
// porque a função já roda com as credenciais no ambiente).
// ============================================
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const BUCKET_NAME = process.env.R2_BUCKET_NAME
const PUBLIC_URL = process.env.R2_PUBLIC_URL

function sanitizeFilename(name) {
  const clean = (name || 'imagem').toLowerCase().replace(/[^a-z0-9.\-]/g, '-')
  return clean.slice(-60)
}

// Baixa a imagem de imageUrl e sobe pro R2, devolvendo a URL pública nova.
// Se a origem falhar (404, timeout, etc.), lança erro — quem chama decide
// se pula essa imagem e segue com as outras (nunca travar o produto todo
// por causa de uma foto).
async function importarImagemParaR2(imageUrl, folder = 'produtos') {
  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME || !PUBLIC_URL) {
    throw new Error('Armazenamento de imagens (R2) não configurado no servidor.')
  }

  const res = await fetch(imageUrl)
  if (!res.ok) {
    throw new Error(`Não foi possível baixar a imagem de origem (${res.status}): ${imageUrl}`)
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg'
  const buffer = Buffer.from(await res.arrayBuffer())

  const nomeArquivo = sanitizeFilename(imageUrl.split('/').pop() || 'imagem.jpg')
  const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nomeArquivo}`

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY }
  })

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }))

  return `${PUBLIC_URL.replace(/\/$/, '')}/${key}`
}

module.exports = { importarImagemParaR2 }
