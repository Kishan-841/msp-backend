import { Server as SocketServer } from 'socket.io';
import { config } from '../config/index.js';
import { prisma } from './prisma.js';
import { verifyAccessToken } from '../services/session.service.js';

let io: SocketServer;

export function initSocket(server: any) {
  io = new SocketServer(server, {
    cors: { origin: config.corsOrigins, credentials: true },
  });

  // Same rules as HTTP: valid token, live session, active user
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = await verifyAccessToken(token);
      const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { isActive: true } });
      if (!user?.isActive) return next(new Error('Invalid token'));
      socket.data.userId = decoded.userId;
      socket.data.sid = decoded.sid;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);
    console.log(`Socket connected: ${userId}`);

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${userId}`);
    });
  });
}

export function getIO() {
  return io;
}

export function emitToUser(userId: string, event: string, data: any) {
  if (io) io.to(`user:${userId}`).emit(event, data);
}

// Any successful change may alter someone's to-do counts. Rather than work out who,
// tell every connected client to refetch its (cheap) counts — debounced so a burst of
// writes becomes one event.
let changeTimer: NodeJS.Timeout | null = null;
export function broadcastDataChanged() {
  if (!io || changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    io.emit('data:changed');
  }, 300);
}

/** Drop live sockets of revoked sessions (logout, password change, deactivation) */
export function disconnectSessions(sids: string[]) {
  if (!io || sids.length === 0) return;
  const set = new Set(sids);
  for (const socket of io.sockets.sockets.values()) {
    if (set.has(socket.data.sid)) socket.disconnect(true);
  }
}
