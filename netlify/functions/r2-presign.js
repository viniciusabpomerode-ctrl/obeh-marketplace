// ============================================
// GERA URL PRÉ-ASSINADA PARA UPLOAD DIRETO NO CLOUDFLARE R2
// Imagens dos artesãos (produtos, lojas, cursos) vão pro R2.
// O resto do banco de dados continua no Supabase.
// ============================================

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const BUCKET_NAME = process.env.R2_BUCKET_NAME
const PUBLIC_URL = process.env.R2_PUBLIC_URL // ex: https://pub-xxxxxxxx.r2.dev (sem barra no final)

const MAX_BYTES = 500 * 1024 // 500KB por imagem (também validado no cliente)
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const ALLOWED_FOLDERS = ['produtos', 'lojas', 'cursos']

function sanitizeFilename(name) {
  const clean = (name || 'imagem').toLowerCase().replace(/[^a-z0-9.\-]/g, '-')
  return clean.slice(-60)
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido.' }) }
  }

  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME || !PUBLIC_URL) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Upload de imagens não configurado no servidor (variáveis de ambiente do R2 ausentes).' })
    }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) }
  }

  const { filename, contentType, folder } = body

  if (!contentType || !ALLOWED_TYPES.includes(contentType)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Tipo de imagem não permitido. Use JPEG, PNG, WEBP ou GIF.' }) }
  }

  const safeFolder = ALLOWED_FOLDERS.includes(folder) ? folder : 'produtos'
  const key = `${safeFolder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeFilename(filename)}`

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY
    }
  })

  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType
    })
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 })
    const publicUrl = `${PUBLIC_URL.replace(/\/$/, '')}/${key}`

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadUrl, publicUrl, maxBytes: MAX_BYTES })
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao gerar URL de upload: ' + err.message }) }
  }
}
