import {
  modelDtoSchema,
  modelListResponseSchema,
  testModelResponseSchema,
  type CreateModelInputPayload,
  type ModelDto,
  type ModelListResponse,
  type TestModelResponse,
  type UpdateModelInputPayload,
} from '@fanxiaoshuo/shared';
import { apiRequest, apiRequestVoid } from './http';

/** `/api/v1/models` 强类型客户端（含一键测通）。 */
export const modelApi = {
  list(): Promise<ModelListResponse> {
    return apiRequest('/models', modelListResponseSchema);
  },

  create(payload: CreateModelInputPayload): Promise<ModelDto> {
    return apiRequest('/models', modelDtoSchema, { method: 'POST', body: payload });
  },

  update(id: string, payload: UpdateModelInputPayload): Promise<ModelDto> {
    return apiRequest(`/models/${encodeURIComponent(id)}`, modelDtoSchema, {
      method: 'PATCH',
      body: payload,
    });
  },

  remove(id: string): Promise<void> {
    return apiRequestVoid(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** 真实调用上游一次，返回预览 / 延迟 / Token / 估算费用。 */
  test(id: string): Promise<TestModelResponse> {
    return apiRequest(`/models/${encodeURIComponent(id)}/test`, testModelResponseSchema, {
      method: 'POST',
    });
  },
};
