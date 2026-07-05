// ============================================
// DELETA UM OU MAIS ARQUIVOS DO CLOUDFLARE R2
// Usado sempre que uma imagem (produto, loja, curso, pasta, benefício de
// apoio) é substituída ou removida, pra não deixar arquivo órfão ocupando
// espaço no bucket pra sempre.
//
// Recebe um array de URLs públicas (as mesmas que uploadImagemR2 retorna)
// e apaga só as que realmente pertencem ao nosso bucket (prefixo
// R2_PUBLIC_URL) — qualquer outra URL é ignorada silenciosamente.
// ============================================

const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3')

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const BUCKET_NAME = process.env.R2_BUCKET_NAME
const PUBLIC_URL = process.env.R2_PUBLIC_URL

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido.' }) }
  }

  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME || !PUBLIC_URL) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Armazenamento de imagens não configurado no servidor.' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) }
  }

  const urls = Array.isArray(body.urls) ? body.urls : []
  const prefixo = `${PUBLIC_URL.replace(/\/$/, '')}/`

  const keys = urls
    .filter(u => typeof u === 'string' && u.startsWith(prefixo))
    .map(u => u.slice(prefixo.length))

  if (keys.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ deletados: 0 }) }
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY
    }
  })

  try {
    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: keys.map(Key => ({ Key })) }
    }))
    return { statusCode: 200, body: JSON.stringify({ deletados: keys.length }) }
  } catch (err) {
    console.error('Erro ao deletar do R2:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao deletar imagem(ns): ' + err.message }) }
  }
}
