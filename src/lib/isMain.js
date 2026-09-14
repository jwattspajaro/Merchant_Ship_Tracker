import { pathToFileURL } from 'node:url';

/**
 * ¿Se esta ejecutando este modulo como programa, o solo importado?
 *
 * Comparar `process.argv[1]` con el final de una ruta no sirve: en Windows Node
 * resuelve argv[1] a una ruta absoluta con barras invertidas
 * ("F:\\Map_Trafic\\src\\api\\server.js"), asi que un endsWith('api/server.js')
 * siempre da falso y el proceso termina sin arrancar nada.
 *
 *   import { isMainModule } from '../lib/isMain.js';
 *   if (isMainModule(import.meta.url)) main();
 */
export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return metaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
