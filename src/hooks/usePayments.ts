import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from 'sonner'

export function usePayments(params?: { agent_id?: string; status?: string }) {
  return useQuery({
    queryKey: ['payments', params],
    queryFn: () => api.listPayments(params),
    refetchInterval: 5_000,
  })
}

export function useApprovePayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.approvePayment(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payments'] }); toast.success('Payment approved') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useRejectPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.rejectPayment(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payments'] }); toast.success('Payment rejected') },
    onError: (e: Error) => toast.error(e.message),
  })
}
