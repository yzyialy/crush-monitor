import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
try {
  await copyFile('.env.example', '.env', constants.COPYFILE_EXCL);
  console.log('已创建 .env。请填入你自己的 TYPESAFE_API_KEY，再运行 npm run build 和 npm start。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env 已存在，保留原配置。');
}
