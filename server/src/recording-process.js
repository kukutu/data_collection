// Observe startup without consuming the streams used to persist recording logs.
export function waitForRecordingReady(child, { readyMessage, timeoutMs = 10_000, initialOutput = '' } = {}) {
  return new Promise((resolve, reject) => {
    let output = String(initialOutput || '');
    let errors = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onOutput);
      child.stderr?.off('data', onErrorOutput);
      child.off('error', onError);
      child.off('close', onClose);
      error ? reject(error) : resolve();
    };
    const inspect = () => {
      const failure = `${output}\n${errors}`.match(/[^\r\n]*(?:RET_ERR_\w+|can not connect|cannot connect|failed|error:)[^\r\n]*/i);
      if (failure) finish(new Error(`录制启动失败: ${failure[0].trim()}`));
      else if (output.includes(readyMessage)) finish();
    };
    const onOutput = (chunk) => { output = `${output}${chunk}`.slice(-8192); inspect(); };
    const onErrorOutput = (chunk) => { errors = `${errors}${chunk}`.slice(-8192); inspect(); };
    const onError = (error) => finish(error);
    const onClose = (code) => finish(new Error(`录制进程在就绪前退出 (${code})`));
    const timer = setTimeout(() => finish(new Error('录制启动超时，未收到设备就绪确认')), timeoutMs);
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onErrorOutput);
    child.on('error', onError);
    child.on('close', onClose);
    inspect();
    if (child.exitCode !== null && child.exitCode !== undefined) onClose(child.exitCode);
  });
}
