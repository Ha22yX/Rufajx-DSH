// The release signing key stays on this Windows build account, protected by
// DPAPI. Only the public SPKI key and signatures enter installation artifacts.
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const updateKeyId = publicKey => createHash('sha256').update(createPublicKey(publicKey).export({type:'spki', format:'der'})).digest('hex');
async function dpapi(bytes, protect) {
  if (process.platform !== 'win32') throw new Error('Release private keys require the Windows build account.');
  const action = protect ? 'Protect' : 'Unprotect';
  const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; ' +
    '$value=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
    'try { $result=[Security.Cryptography.ProtectedData]::'+action+'($value,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Console]::Out.Write([Convert]::ToBase64String($result)) } finally { [Array]::Clear($value,0,$value.Length); if($null -ne $result){[Array]::Clear($result,0,$result.Length)} }';
  return new Promise((resolveBytes,reject) => {
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output=''; child.stdout.on('data', b=>{output+=b;}); child.stderr.resume();
    child.once('error',()=>reject(new Error('Windows release key protection unavailable.')));
    child.once('close',code=>{
      if(code!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return reject(new Error('Windows release key operation failed.'));
      resolveBytes(Buffer.from(output,'base64')); output='';
    });
    child.stdin.on('error',()=>{}); child.stdin.end(bytes.toString('base64'));
  });
}
export async function createUpdateSigningKey(privateFile, publicFile) {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:3072,publicExponent:65537});
  const pem=publicKey.export({type:'spki',format:'pem'}), keyId=updateKeyId(pem);
  const clear=privateKey.export({type:'pkcs8',format:'der'});
  let encrypted;
  try { encrypted=await dpapi(clear,true); } finally { clear.fill(0); }
  await mkdir(dirname(resolve(privateFile)),{recursive:true});
  await mkdir(dirname(resolve(publicFile)),{recursive:true});
  await writeFile(privateFile,JSON.stringify({schema:1,keyId,protection:'windows-dpapi-current-user',privateKey:encrypted.toString('base64')})+'\n',{flag:'wx',mode:0o600,flush:true});
  await writeFile(publicFile,pem,{flag:'wx',flush:true});
  const jwk=publicKey.export({format:'jwk'});
  return {keyId,publicKey:pem,modulus:Buffer.from(jwk.n,'base64url').toString('base64'),exponent:Buffer.from(jwk.e,'base64url').toString('base64')};
}
export async function readUpdateSigningKey(privateFile) {
  const stored=JSON.parse(await readFile(privateFile,'utf8'));
  if(stored.schema!==1 || stored.protection!=='windows-dpapi-current-user' || !/^[a-f0-9]{64}$/.test(stored.keyId)) throw new Error('Invalid release key storage.');
  const clear=await dpapi(Buffer.from(stored.privateKey,'base64'),false);
  let key;
  try { key=createPrivateKey({key:clear,type:'pkcs8',format:'der'}); } finally { clear.fill(0); }
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength!==3072) throw new Error('Unexpected release signing key type.');
  const publicKey=createPublicKey(key).export({type:'spki',format:'pem'});
  if(updateKeyId(publicKey)!==stored.keyId) throw new Error('Release signing identity mismatch.');
  return {keyId:stored.keyId,publicKey,sign(bytes){return sign('sha256',bytes,key).toString('base64');}};
}
export function verifyUpdateSignature(bytes,{keyId,signature,algorithm},publicKey) {
  if(algorithm!=='rsa-sha256'||keyId!==updateKeyId(publicKey) || typeof signature!=='string' || !/^[A-Za-z0-9+/]{512}$/.test(signature)) return false;
  return verify('sha256',bytes,publicKey,Buffer.from(signature,'base64'));
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [mode,privateFile,publicFile]=process.argv.slice(2);
  if(mode!=='generate' || !privateFile || !publicFile) throw new Error('Usage: client-update-signing.mjs generate PRIVATE_DPAPI_FILE PUBLIC_PEM_FILE');
  console.log(JSON.stringify(await createUpdateSigningKey(privateFile,publicFile)));
}
