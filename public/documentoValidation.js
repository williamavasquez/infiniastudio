// Validación de números de documento de identidad peruanos por Tipo Doc.
// UMD: funciona tanto con require() en Node (server.js) como cargado
// directamente en el navegador (<script src="documentoValidation.js">).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DocumentoValidation = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // 01 — DNI / Libreta Electoral: exactamente 8 dígitos.
  // 04 — Carnet de Extranjería: sin formato fijo, alfanumérico 6-20.
  // 06 — RUC: exactamente 11 dígitos (forma; ver validarRucDigitoVerificador para el check-digit).
  // 07 — Pasaporte: sin formato fijo, alfanumérico hasta 20.
  const REGEX_POR_TIPO = {
    DNI: /^\d{8}$/,
    'MENOR DE EDAD': /^\d{8}$/, // DNI de menor: mismo formato que el DNI regular.
    CE: /^[A-Z0-9]{6,20}$/,
    RUC: /^\d{11}$/,
    PASAPORTE: /^[A-Z0-9]{6,20}$/,
  };

  function validarFormatoDocumento(tipoDoc, documento) {
    const regex = REGEX_POR_TIPO[tipoDoc];
    if (!regex) return true; // Tipo desconocido: no bloqueamos, dejamos pasar.
    return regex.test(String(documento || '').trim().toUpperCase());
  }

  // Validación estricta del RUC (algoritmo módulo 11 de SUNAT). Separada de
  // validarFormatoDocumento porque es la única con un algoritmo real de
  // dígito verificador — el resto son solo validaciones de forma.
  const RUC_FACTORES = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const RUC_LOOKUP = ['6', '7', '8', '9', '0', '1', '1', '2', '3', '4', '5'];

  function validarRucDigitoVerificador(ruc) {
    const value = String(ruc || '').trim();
    if (!/^\d{11}$/.test(value)) return false;

    const digitos = value.slice(0, 10).split('').map(Number);
    const suma = digitos.reduce((acc, d, i) => acc + d * RUC_FACTORES[i], 0);
    const resto = suma % 11;
    return RUC_LOOKUP[resto] === value[10];
  }

  return { REGEX_POR_TIPO, validarFormatoDocumento, validarRucDigitoVerificador };
});
