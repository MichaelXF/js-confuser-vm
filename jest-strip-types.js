import { stripTypeScriptTypes } from 'node:module';

export default {
  process(code, filePath) {
    if (filePath.endsWith('.ts')) {
      return { code: stripTypeScriptTypes(code) };
    }
    return { code };
  },
};
