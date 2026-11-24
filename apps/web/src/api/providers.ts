import {
  providerDtoSchema,
  providerListResponseSchema,
  type CreateProviderInputPayload,
  type ProviderDto,
  type ProviderListResponse,
  type UpdateProviderInputPayload,
} from '@fanxiaoshuo/shared';
import { apiRequest, apiRequestVoid } from './http';

/** `/api/v1/providers` 强类型客户端。 */
export const providerApi = {
  list(): Promise<ProviderListResponse> {
    return apiRequest('/providers', providerListResponseSchema);
  },

  create(payload: CreateProviderInputPayload): Promise<ProviderDto> {
    return apiRequest('/providers', providerDtoSchema, { method: 'POST', body: payload });
  },

  update(id: string, payload: UpdateProviderInputPayload): Promise<ProviderDto> {
    return apiRequest(`/providers/${encodeURIComponent(id)}`, providerDtoSchema, {
      method: 'PATCH',
      body: payload,
    });
  },

  remove(id: string): Promise<void> {
    return apiRequestVoid(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
