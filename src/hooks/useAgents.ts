import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Agent } from '@/lib/api'
import { toast } from 'sonner'

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api.listAgents(),
    refetchInterval: 10_000,
  })
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: ['agent', id],
    queryFn: () => api.getAgent(id),
    refetchInterval: 5_000,
    enabled: Boolean(id),
  })
}

export function useCreateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; description?: string; policy?: Partial<Agent> }) =>
      api.createAgent(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      toast.success('Agent created')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function usePauseAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.pauseAgent(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['agents'] }); toast.success('Agent paused') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useResumeAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.resumeAgent(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['agents'] }); toast.success('Agent resumed') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useRevokeAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.revokeAgent(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['agents'] }); toast.success('Agent revoked') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdatePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, policy }: { id: string; policy: Partial<Agent> }) => api.updatePolicy(id, policy),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      void qc.invalidateQueries({ queryKey: ['agent', vars.id] })
      toast.success('Policy updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
