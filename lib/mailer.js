const nodemailer = require('nodemailer');

// SMTP se configura por variables de entorno, igual que DATABASE_URL. Si no
// están, el envío queda deshabilitado y la UI lo informa en vez de fallar con
// un error críptico (imprimir y descargar siguen funcionando sin esto).
//
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465
//   SMTP_USER=cotizaciones@infinia.pe
//   SMTP_PASS=<app password>
//   SMTP_FROM="Infinia <cotizaciones@infinia.pe>"   (opcional, default SMTP_USER)
function mailConfigurado() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;

function getTransporter() {
  if (!mailConfigurado()) {
    throw new Error(
      'El envío por correo no está configurado. Definí SMTP_HOST, SMTP_USER y SMTP_PASS en el servidor.'
    );
  }
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 465 = TLS implícito; 587 = STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

function remitente() {
  return process.env.SMTP_FROM || process.env.SMTP_USER;
}

async function enviarCorreo({ to, subject, text, html, attachments }) {
  const info = await getTransporter().sendMail({
    from: remitente(),
    to,
    subject,
    text,
    html,
    attachments,
  });
  return info;
}

module.exports = { mailConfigurado, enviarCorreo, remitente };
