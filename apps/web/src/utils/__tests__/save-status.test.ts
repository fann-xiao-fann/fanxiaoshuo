import { describe, expect, it } from 'vitest';
import { describeSaveStatus } from '@/utils/save-status';

describe('describeSaveStatus', () => {
  it('未修改时展示「无改动」', () => {
    expect(describeSaveStatus('idle', null)).toEqual({ label: '无改动', tone: 'idle' });
  });

  it('本地有改动时提示未保存', () => {
    expect(describeSaveStatus('dirty', null)).toEqual({ label: '未保存', tone: 'dirty' });
  });

  it('保存中展示进行态', () => {
    expect(describeSaveStatus('saving', null)).toEqual({ label: '保存中…', tone: 'saving' });
  });

  it('已保存时附带 HH:mm:ss 时间', () => {
    const saved = describeSaveStatus('saved', '2024-05-01T09:08:07.000Z');
    expect(saved.tone).toBe('saved');
    expect(saved.label).toMatch(/^已保存 \d{2}:\d{2}:\d{2}$/);
  });

  it('缺少时间戳时仍展示已保存', () => {
    expect(describeSaveStatus('saved', null)).toEqual({ label: '已保存', tone: 'saved' });
    expect(describeSaveStatus('saved', 'not-a-date')).toEqual({ label: '已保存', tone: 'saved' });
  });

  it('保存失败与版本冲突分别给出错误色调', () => {
    expect(describeSaveStatus('error', null)).toEqual({ label: '保存失败', tone: 'error' });
    expect(describeSaveStatus('conflict', null)).toEqual({ label: '版本冲突', tone: 'conflict' });
  });
});
