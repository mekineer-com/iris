import {useEffect, useRef, useState} from "react"

import type {Channels} from "../../shared/channels"

export function useChannel<C extends keyof Channels & string>(
  channel: C,
  initial?: Channels[C],
): Channels[C] | undefined {
  const [value, setValue] = useState<Channels[C] | undefined>(initial)
  const initialRef = useRef(initial)
  useEffect(() => {
    setValue(initialRef.current)
    return (mentra.on as (c: string, cb: (p: unknown) => void) => () => void)(
      channel,
      (payload) => setValue(payload as Channels[C]),
    )
  }, [channel])
  return value
}
