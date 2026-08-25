const BLOCKED_PATTERNS = [
  /自动支付|立即支付|去支付|支付密码|扫码支付|刷脸支付|付款|付钱/,
  /下单|提交订单|确认订单|购买|买票|购票|抢票|抢单|抢红包|领红包/,
  /立即叫车|呼叫.*车|确认叫车|叫车下单/,
  /评论|私信|关注|点赞|打赏/,
  /验证码|人机验证|绕过/,
];

const ALLOWED_INTENTS = new Set([
  'launch_app',
  'watch_feed',
  'watch_live',
  'live_entry',
  'play_tencent_video',
  'play_generic_media',
  'amap_navigation',
  'wechat_channels_feed',
  'ai_chat',
  'doubao_chat',
  'back',
  'home',
]);

export function evaluateSafety(parsedTask, originalText = '') {
  const text = `${originalText} ${JSON.stringify(parsedTask)}`;
  const blocked = BLOCKED_PATTERNS.find((pattern) => pattern.test(text));

  if (blocked) {
    return {
      allowed: false,
      reason: `任务包含高风险动作“${blocked.source}”，不会自动执行。`,
    };
  }

  if (parsedTask?.intent === 'missing_parameter') {
    if (parsedTask.field === 'destination') {
      return {
        allowed: false,
        reason: parsedTask.message || '任务缺少目的地。',
      };
    }
    return {
      allowed: false,
      reason: parsedTask.message || `任务缺少必要参数“${parsedTask.field || 'unknown'}”。`,
    };
  }

  if (parsedTask?.intent === 'unsupported_flow') {
    return {
      allowed: false,
      reason: parsedTask.reason || '该业务流暂未实现真实可验证的自动化 skill。',
    };
  }

  if (!ALLOWED_INTENTS.has(parsedTask?.intent)) {
    return {
      allowed: false,
      reason: `暂不支持自动执行意图“${parsedTask?.intent || 'unknown'}”。`,
    };
  }

  if (parsedTask?.intent === 'amap_navigation' && !String(parsedTask.destination || '').trim()) {
    return {
      allowed: false,
      reason: '高德导航任务缺少目的地。',
    };
  }

  if (parsedTask?.intent === 'doubao_chat' && parsedTask.language && parsedTask.language !== 'en') {
    return {
      allowed: false,
      reason: '当前豆包自动聊天仅允许英文短句输入。',
    };
  }

  if (parsedTask?.intent === 'ai_chat' && parsedTask.language && parsedTask.language !== 'en') {
    return {
      allowed: false,
      reason: '当前 AI 应用自动聊天仅允许英文短句输入。',
    };
  }

  return { allowed: true };
}
