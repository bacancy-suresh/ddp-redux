import max from 'lodash/max';
import values from 'lodash/values';
import {
  DEFAULT_SOCKET_ID,

  DDP_RESULT,
  DDP_CONNECTED,
  DDP_METHOD,
  DDP_SUB,
  DDP_ENQUEUE,

  MESSAGE_TO_ACTION,
  ACTION_TO_MESSAGE,
  ACTION_TO_PRIORITY,
} from '../../constants';

/**
 * Return the maximal priority of the current pending messages.
 * @param {object} state
 * @param {string} socketId
 * @returns {number}
 */
const getMessageThreshold = (state, socketId) => {
  const priorities = values(state.ddp.messages.sockets[socketId] &&
                            state.ddp.messages.sockets[socketId].pending);
  if (priorities.length === 0) {
    return -Infinity;
  }
  return max(priorities);
};

/**
 * Create middleware for the given ddpClient.
 * @param {DDPClient} ddpClient
 */
export const createMiddleware = ddpClient => (store) => {
  ddpClient.on('message', (payload, meta) => {
    const type = payload.msg && MESSAGE_TO_ACTION[payload.msg];
    if (type) {
      store.dispatch({
        type,
        payload,
        meta,
      });
    }
  });
  return next => (action) => {
    if (!action || typeof action !== 'object') {
      return next(action);
    }
    const socketId = (action.meta && action.meta.socketId) || DEFAULT_SOCKET_ID;
    if (action.type === DDP_CONNECTED || action.type === DDP_RESULT) {
      // NOTE: We are propagating action first, because
      //       we want to get an up-to-date threshold.
      const result = next(action);
      const state = store.getState();
      const queue = state.ddp.messages.sockets[socketId] &&
                    state.ddp.messages.sockets[socketId].queue;
      if (queue) {
        let t = getMessageThreshold(state, socketId);
        let i = 0;
        while (i < queue.length && t <= queue[i].meta.priority) {
          store.dispatch(queue[i]);
          // Note that threshold might have changed after dispatching another action.
          t = getMessageThreshold(store.getState(), socketId);
          i += 1;
        }
      }
      return result;
    }
    const msg = ACTION_TO_MESSAGE[action.type];
    if (!msg) {
      return next(action);
    }
    const priority = ACTION_TO_PRIORITY[action.type] || 0;
    const newAction = {
      ...action,
      payload: {
        ...action.payload,
        msg,
      },
      meta: {
        priority, // action may overwrite it's priority
        socketId, // action may overwrite it's socketId
        ...action.meta,
      },
    };
    // Ensure that method & sub messages always have valid unique id
    if (action.type === DDP_METHOD || action.type === DDP_SUB) {
      newAction.payload.id = newAction.payload.id || ddpClient.nextUniqueId();
    }
    const state = store.getState();
    const threshold = getMessageThreshold(state, socketId);
    if (newAction.meta.priority >= threshold) {
      // NOTE: Initially (before "connected" message is received), the threshold will be set
      //       to "connect" action priority which is the highest possible. As a result, nothing
      //       will be sent until the connection is established.
      ddpClient.send(newAction.payload, newAction.meta);
      return next(newAction);
    }
    return store.dispatch({
      type: DDP_ENQUEUE,
      payload: newAction.payload,
      meta: {
        type: newAction.type,
        ...newAction.meta,
      },
    });
  };
};
