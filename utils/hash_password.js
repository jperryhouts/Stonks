#!/usr/bin/env node
// Generate a scrypt-hashed password for use in AUTH_PASS.
// Usage: node utils/hash_password.js <password>
//    or: echo "password" | node utils/hash_password.js

const crypto = require("crypto");

const SCRYPT_PREFIX = "scrypt:";
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;

function hashPassword(password) {
    const salt = crypto.randomBytes(SALT_LEN);
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
    return SCRYPT_PREFIX + salt.toString("base64") + ":" + hash.toString("base64");
}

if (process.argv[2]) {
    console.log(hashPassword(process.argv[2]));
} else {
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
        const password = input.trimEnd();
        if (!password) {
            console.error("Usage: node utils/hash_password.js <password>");
            process.exit(1);
        }
        console.log(hashPassword(password));
    });
}
