const sharp = require("sharp");
const fs = require("fs");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#14161F"/>
  <rect x="10" y="10" width="19" height="19" rx="4.5" fill="none" stroke="#F2F3F7" stroke-width="4.5"/>
  <rect x="35" y="10" width="19" height="19" rx="4.5" fill="#C4553C"/>
  <rect x="10" y="35" width="19" height="19" rx="4.5" fill="none" stroke="#F2F3F7" stroke-width="4.5"/>
  <rect x="35" y="35" width="19" height="19" rx="4.5" fill="none" stroke="#F2F3F7" stroke-width="4.5" opacity=".45"/>
</svg>`;

fs.mkdirSync("public/icons", { recursive: true });

Promise.all([
  sharp(Buffer.from(svg)).resize(192, 192).png().toFile("public/icons/icon-192.png"),
  sharp(Buffer.from(svg)).resize(512, 512).png().toFile("public/icons/icon-512.png"),
  sharp(Buffer.from(svg)).resize(512, 512).png().toFile("public/icons/icon-512-maskable.png"),
]).then(() => console.log("icons generated"));
