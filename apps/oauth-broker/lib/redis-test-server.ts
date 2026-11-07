// Test-only RESP/HTTP bridge: the production @vercel/kv SDK talks to this
// endpoint, but every command (including Lua) executes on disposable Redis.
import { createConnection, type NetConnectOpts } from 'node:net';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

export async function redisTestServer() {
  let child: ChildProcess | undefined;
  let directory: string | undefined;
  let connection: NetConnectOpts;
  if (process.env.REDIS_URL) {
    const url = new URL(process.env.REDIS_URL);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('Integration Redis must be disposable and local');
    connection = { host: url.hostname, port: Number(url.port || 6379) };
  } else {
    directory = await mkdtemp('/tmp/broker-redis-');
    connection = { path: `${directory}/redis.sock` };
    child = spawn(process.env.REDIS_SERVER || 'redis-server', [
      '--port', '0', '--unixsocket', connection.path!, '--unixsocketperm', '700',
      '--save', '', '--appendonly', 'no', '--dir', directory,
    ], { stdio: 'ignore' });
  }

  const prefix = `session:broker-test-${randomUUID()}:`;
  const ownedKeys = new Set<string>();
  const command = (input: (string | number)[]): Promise<unknown> => new Promise((resolve, reject) => {
    const args = input.map(arg => {
      if (typeof arg !== 'string' || !arg.startsWith('session:')) return arg;
      const key = prefix + arg.slice('session:'.length);
      ownedKeys.add(key);
      return key;
    });
    const socket = createConnection(connection);
    let buffer = Buffer.alloc(0);
    socket.on('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('Redis test command timed out')));
    socket.on('connect', () => {
      socket.write(`*${args.length}\r\n` + args.map(arg => {
        const text = String(arg);
        return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
      }).join(''));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const header = buffer.subarray(1, end).toString();
      if (buffer[0] === 36) {
        const length = Number(header);
        if (length !== -1 && buffer.length < end + 2 + length + 2) return;
        resolve(length === -1 ? null : buffer.subarray(end + 2, end + 2 + length).toString());
      } else if (buffer[0] === 45) {
        reject(new Error(header));
      } else if (buffer[0] === 58) {
        resolve(Number(header));
      } else {
        resolve(header);
      }
      socket.destroy();
    });
  });

  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as (string | number)[] | (string | number)[][];
      const pipeline = req.url === '/pipeline';
      const commands = pipeline ? body as (string | number)[][] : [body as (string | number)[]];
      const replies = await Promise.all(commands.map(async args => {
        try {
          const value = await command(args);
          const result = req.headers['upstash-encoding'] === 'base64' && typeof value === 'string' && value !== 'OK'
            ? Buffer.from(value).toString('base64') : value;
          return { result };
        } catch {
          return { error: 'Redis integration command failed' };
        }
      }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(pipeline ? replies : replies[0]));
    } catch {
      res.statusCode = 500;
      res.end('{"error":"Invalid integration request"}');
    }
  });
  const stop = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    // Prefix isolation also makes REDIS_URL runs repeatable without touching
    // any pre-existing session keys on a local development Redis instance.
    if (ownedKeys.size) {
      // command() adds the prefix, so pass the original logical key names.
      await command(['DEL', ...Array.from(ownedKeys, key => `session:${key.slice(prefix.length)}`)]);
    }
    if (child?.pid && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  let spawnError: Error | undefined;
  child?.on('error', error => { spawnError = error; });
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      if (spawnError) throw spawnError;
      try { await command(['PING']); break; } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    return { url: `http://127.0.0.1:${address.port}`, command, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
