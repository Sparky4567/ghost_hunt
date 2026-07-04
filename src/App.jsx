import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteSession,
  exportableSession,
  importedSession,
  importSessions,
  listSessions,
  saveSession,
  sqliteStatus,
} from './storage'
import './App.css'

const emptyReading = (detail = 'Idle') => ({
  value: null,
  unit: '',
  detail,
  supported: false,
  active: false,
  strength: 0,
})

const formatNumber = (value, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : '--'

const createId = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`

const circularDelta = (current, previous) => {
  const delta = Math.abs(current - previous) % 360
  return delta > 180 ? 360 - delta : delta
}

const stopTracks = (stream) => {
  stream?.getTracks().forEach((track) => track.stop())
}

const readingSnapshot = (magnetometer, proximity, gravity, disturbance) => ({
  disturbance,
  magnetometer,
  proximity,
  gravity,
  capturedAt: Date.now(),
})

const clampPercent = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
const SIGNAL_SMOOTHING = 0.16
const BEEP_SHIFT_THRESHOLD = 35
const BEEP_HIGH_THRESHOLD = 85
const BEEP_COOLDOWN_MS = 1200
const TRANSCRIPTION_LANGUAGES = [
  { value: 'auto', label: 'Auto' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'lt-LT', label: 'Lithuanian' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pl-PL', label: 'Polish' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'uk-UA', label: 'Ukrainian' },
]

function useSmoothedPercent(target) {
  const normalizedTarget = clampPercent(target)
  const targetRef = useRef(normalizedTarget)
  const currentRef = useRef(normalizedTarget)
  const frameRef = useRef(null)
  const [displayed, setDisplayed] = useState(Math.round(normalizedTarget))

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    targetRef.current = normalizedTarget
    if (prefersReducedMotion) {
      currentRef.current = normalizedTarget
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        setDisplayed(Math.round(normalizedTarget))
        frameRef.current = null
      })
      return undefined
    }

    if (frameRef.current) return undefined

    const tick = () => {
      const next = targetRef.current
      const current = currentRef.current
      const eased = current + (next - current) * SIGNAL_SMOOTHING

      if (Math.abs(next - eased) < 0.35) {
        currentRef.current = next
        setDisplayed(Math.round(next))
        frameRef.current = null
        return
      }

      currentRef.current = eased
      setDisplayed(Math.round(eased))
      frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return undefined
  }, [normalizedTarget])

  useEffect(() => {
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  return displayed
}

function App() {
  const [magnetometer, setMagnetometer] = useState(() => emptyReading())
  const [proximity, setProximity] = useState(() => emptyReading())
  const [gravity, setGravity] = useState(() => emptyReading())
  const [transcript, setTranscript] = useState('')
  const [speechSupported, setSpeechSupported] = useState(false)
  const [recorderState, setRecorderState] = useState('Ready')
  const [mediaState, setMediaState] = useState('No media captured')
  const [mediaMode, setMediaMode] = useState('audio')
  const [recording, setRecording] = useState(false)
  const [currentBlob, setCurrentBlob] = useState(null)
  const [currentMimeType, setCurrentMimeType] = useState('')
  const [sessions, setSessions] = useState([])
  const [storageState, setStorageState] = useState('IndexedDB ready')
  const [installPrompt, setInstallPrompt] = useState(null)
  const [isStandalone, setIsStandalone] = useState(false)
  const [path, setPath] = useState(() => window.location.pathname)
  const [searchQuery, setSearchQuery] = useState('')
  const [beepEnabled, setBeepEnabled] = useState(false)
  const [beepState, setBeepState] = useState('Sensor beep off')
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('auto')
  const fileInputRef = useRef(null)
  const sensorsRef = useRef({})
  const mediaRecorderRef = useRef(null)
  const mediaChunksRef = useRef([])
  const mediaStreamRef = useRef(null)
  const recognitionRef = useRef(null)
  const transcriptRef = useRef('')
  const finalTranscriptRef = useRef('')
  const latestTranscriptRef = useRef('')
  const legacyProximityRef = useRef(null)
  const orientationFallbackRef = useRef(null)
  const motionFallbackRef = useRef(null)
  const proximityFallbackRef = useRef(null)
  const proximityFallbackStreamRef = useRef(null)
  const audioContextRef = useRef(null)
  const previousDisturbanceRef = useRef(0)
  const lastBeepAtRef = useRef(0)

  const disturbance = useMemo(() => {
    return Math.round(
      magnetometer.strength * 0.45 + proximity.strength * 0.25 + gravity.strength * 0.3,
    )
  }, [gravity.strength, magnetometer.strength, proximity.strength])
  const displayedMagnetometerStrength = useSmoothedPercent(magnetometer.strength)
  const displayedProximityStrength = useSmoothedPercent(proximity.strength)
  const displayedGravityStrength = useSmoothedPercent(gravity.strength)
  const displayedDisturbance = useSmoothedPercent(disturbance)

  const sqlite = useMemo(() => sqliteStatus(), [])
  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return sessions

    return sessions.filter((session) => {
      const searchable = [
        session.title,
        session.transcript,
        session.mediaMode,
        session.mediaType,
        session.transcriptionLanguage,
        new Date(session.createdAt).toLocaleString(),
        `${session.sensorSnapshot?.disturbance ?? 0}% disturbance`,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return searchable.includes(query)
    })
  }, [searchQuery, sessions])

  const playSensorBeep = useCallback((level) => {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) {
      setBeepState('Web Audio unavailable')
      return
    }

    const context = audioContextRef.current || new AudioContext()
    audioContextRef.current = context

    if (context.state === 'suspended') context.resume()

    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const now = context.currentTime
    const frequency = 520 + Math.min(level, 100) * 7

    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(frequency, now)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.2)
  }, [])

  const refreshSessions = async () => {
    try {
      setSessions(await listSessions())
      setStorageState('IndexedDB ready')
    } catch (error) {
      setStorageState(error.message)
    }
  }

  const updateTranscript = (value) => {
    transcriptRef.current = value
    latestTranscriptRef.current = value.trim()
    setTranscript(value)
  }

  useEffect(() => {
    const liveSensors = sensorsRef.current
    const hasMagnetometer = 'Magnetometer' in window
    const hasOrientationFallback = 'DeviceOrientationEvent' in window
    const hasGravity = 'GravitySensor' in window
    const hasProximity = 'ondeviceproximity' in window || 'ProximitySensor' in window
    const hasProximityFallback = Boolean(navigator.mediaDevices?.getUserMedia)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition

    setMagnetometer((reading) => ({
      ...reading,
      supported: hasMagnetometer || hasOrientationFallback,
      detail: hasMagnetometer
        ? 'Ready'
        : hasOrientationFallback
          ? 'Orientation fallback ready'
          : 'Magnetometer API unavailable',
    }))
    setGravity((reading) => ({
      ...reading,
      supported: hasGravity,
      detail: hasGravity ? 'Ready' : 'Gravity Sensor API unavailable',
    }))
    setProximity((reading) => ({
      ...reading,
      supported: hasProximity || hasProximityFallback,
      detail: hasProximity
        ? 'Ready'
        : hasProximityFallback
          ? 'Camera occlusion fallback ready'
          : 'Proximity API unavailable',
    }))
    setSpeechSupported(Boolean(SpeechRecognition))
    setRecorderState(SpeechRecognition ? 'Ready' : 'Speech recognition unavailable')
    setIsStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true,
    )

    refreshSessions()

    const onBeforeInstallPrompt = (event) => {
      event.preventDefault()
      setInstallPrompt(event)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      recognitionRef.current?.stop()
      mediaRecorderRef.current?.stop()
      stopTracks(mediaStreamRef.current)
      disarmAllSensors(liveSensors)
      audioContextRef.current?.close()
    }
  }, [])

  const disarmAllSensors = (sensorStore = sensorsRef.current) => {
    Object.values(sensorStore).forEach((sensor) => sensor?.stop?.())
    sensorsRef.current = {}

    if (legacyProximityRef.current) {
      window.removeEventListener('deviceproximity', legacyProximityRef.current)
      legacyProximityRef.current = null
    }

    if (orientationFallbackRef.current) {
      window.removeEventListener('deviceorientationabsolute', orientationFallbackRef.current)
      window.removeEventListener('deviceorientation', orientationFallbackRef.current)
      orientationFallbackRef.current = null
    }

    if (motionFallbackRef.current) {
      window.removeEventListener('devicemotion', motionFallbackRef.current)
      motionFallbackRef.current = null
    }

    if (proximityFallbackRef.current) {
      cancelAnimationFrame(proximityFallbackRef.current)
      proximityFallbackRef.current = null
    }

    stopTracks(proximityFallbackStreamRef.current)
    proximityFallbackStreamRef.current = null

    setMagnetometer((reading) => ({
      ...emptyReading(reading.supported ? 'Ready' : 'Magnetometer unavailable'),
      supported: reading.supported,
    }))
    setProximity((reading) => ({
      ...emptyReading(reading.supported ? 'Ready' : 'Proximity unavailable'),
      supported: reading.supported,
    }))
    setGravity((reading) => ({
      ...emptyReading(reading.supported ? 'Ready' : 'Gravity unavailable'),
      supported: reading.supported,
    }))
  }

  useEffect(() => {
    if (!beepEnabled) {
      previousDisturbanceRef.current = disturbance
      return
    }

    const previous = previousDisturbanceRef.current
    const shift = Math.abs(disturbance - previous)
    const now = Date.now()
    const canBeep = now - lastBeepAtRef.current > BEEP_COOLDOWN_MS

    if (canBeep && (shift >= BEEP_SHIFT_THRESHOLD || disturbance >= BEEP_HIGH_THRESHOLD)) {
      playSensorBeep(disturbance)
      lastBeepAtRef.current = now
    }

    previousDisturbanceRef.current = disturbance
  }, [beepEnabled, disturbance, playSensorBeep])

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname)

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (nextPath) => {
    window.history.pushState(null, '', nextPath)
    setPath(nextPath)
  }

  const toggleBeep = async () => {
    const nextEnabled = !beepEnabled
    if (nextEnabled) {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (!AudioContext) {
        setBeepState('Web Audio unavailable')
        return
      }

      const context = audioContextRef.current || new AudioContext()
      audioContextRef.current = context
      if (context.state === 'suspended') await context.resume()
      setBeepState('Sensor beep armed')
      previousDisturbanceRef.current = disturbance
      playSensorBeep(35)
    } else {
      setBeepState('Sensor beep off')
    }

    setBeepEnabled(nextEnabled)
  }

  const startMagnetometer = () => {
    if (sensorsRef.current.magnetometer || orientationFallbackRef.current) return

    const startOrientationFallback = async () => {
      if (!('DeviceOrientationEvent' in window)) return

      try {
        if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
          const permission = await window.DeviceOrientationEvent.requestPermission()
          if (permission !== 'granted') throw new Error('Orientation permission denied')
        }

        let previousHeading = null
        const onOrientation = (event) => {
          const heading =
            typeof event.webkitCompassHeading === 'number'
              ? event.webkitCompassHeading
              : event.absolute && typeof event.alpha === 'number'
                ? 360 - event.alpha
                : typeof event.alpha === 'number'
                  ? 360 - event.alpha
                  : null

          if (heading === null) return

          const drift = previousHeading === null ? 0 : circularDelta(heading, previousHeading)
          previousHeading = heading
          setMagnetometer({
            value: heading,
            unit: 'deg',
            detail: `Orientation fallback / heading ${formatNumber(
              heading,
              0,
            )} / drift ${formatNumber(drift, 0)}`,
            supported: true,
            active: true,
            strength: Math.round(Math.min(drift / 45, 1) * 100),
          })
        }

        orientationFallbackRef.current = onOrientation
        window.addEventListener('deviceorientationabsolute', onOrientation)
        window.addEventListener('deviceorientation', onOrientation)
        setMagnetometer((reading) => ({
          ...reading,
          detail: 'Orientation fallback listening',
          supported: true,
          active: true,
        }))
      } catch (error) {
        setMagnetometer((reading) => ({
          ...reading,
          detail: error.message,
          active: false,
        }))
      }
    }

    if ('Magnetometer' in window) {
      try {
        const sensor = new window.Magnetometer({ frequency: 10 })
        sensor.addEventListener('reading', () => {
          const value = Math.hypot(sensor.x, sensor.y, sensor.z)
          setMagnetometer({
            value,
            unit: 'uT',
            detail: `Native / x ${formatNumber(sensor.x)} / y ${formatNumber(
              sensor.y,
            )} / z ${formatNumber(sensor.z)}`,
            supported: true,
            active: true,
            strength: Math.round(Math.min(value / 120, 1) * 100),
          })
        })
        sensor.addEventListener('error', (event) => {
          setMagnetometer((reading) => ({
            ...reading,
            detail: event.error?.message || 'Sensor permission denied',
            active: false,
          }))
          startOrientationFallback()
        })
        sensor.start()
        sensorsRef.current.magnetometer = sensor
        return
      } catch (error) {
        setMagnetometer((reading) => ({ ...reading, detail: error.message }))
      }
    }

    startOrientationFallback()
  }

  const startGravity = () => {
    if (sensorsRef.current.gravity || motionFallbackRef.current) return

    const startMotionFallback = async () => {
      if (!('DeviceMotionEvent' in window)) return

      try {
        if (typeof window.DeviceMotionEvent.requestPermission === 'function') {
          const permission = await window.DeviceMotionEvent.requestPermission()
          if (permission !== 'granted') throw new Error('Motion permission denied')
        }

        const onMotion = (event) => {
          const acceleration = event.accelerationIncludingGravity || event.acceleration
          if (!acceleration) return

          const x = acceleration.x || 0
          const y = acceleration.y || 0
          const z = acceleration.z || 0
          const value = Math.hypot(x, y, z)
          const tilt = Math.min(Math.abs(x) + Math.abs(y), 20)

          setGravity({
            value: { x, y, z, strength: value },
            unit: 'm/s2',
            detail: `Motion fallback / x ${formatNumber(x)} / y ${formatNumber(
              y,
            )} / z ${formatNumber(z)}`,
            supported: true,
            active: true,
            strength: Math.round((tilt / 20) * 100),
          })
        }

        motionFallbackRef.current = onMotion
        window.addEventListener('devicemotion', onMotion)
        setGravity((reading) => ({
          ...reading,
          detail: 'Motion fallback listening',
          supported: true,
          active: true,
        }))
      } catch (error) {
        setGravity((reading) => ({ ...reading, detail: error.message, active: false }))
      }
    }

    if ('GravitySensor' in window) {
      try {
        const sensor = new window.GravitySensor({ frequency: 10 })
        sensor.addEventListener('reading', () => {
          const value = Math.hypot(sensor.x, sensor.y, sensor.z)
          const tilt = Math.min(Math.abs(sensor.x) + Math.abs(sensor.y), 20)
          setGravity({
            value: { x: sensor.x, y: sensor.y, z: sensor.z, strength: value },
            unit: 'm/s2',
            detail: `Native / x ${formatNumber(sensor.x)} / y ${formatNumber(
              sensor.y,
            )} / z ${formatNumber(sensor.z)}`,
            supported: true,
            active: true,
            strength: Math.round((tilt / 20) * 100),
          })
        })
        sensor.addEventListener('error', (event) => {
          setGravity((reading) => ({
            ...reading,
            detail: event.error?.message || 'Sensor permission denied',
            active: false,
          }))
          startMotionFallback()
        })
        sensor.start()
        sensorsRef.current.gravity = sensor
        return
      } catch (error) {
        setGravity((reading) => ({ ...reading, detail: error.message }))
      }
    }

    startMotionFallback()
  }

  const startProximity = () => {
    if (
      sensorsRef.current.proximity ||
      legacyProximityRef.current ||
      proximityFallbackRef.current
    ) {
      return
    }

    const startCameraFallback = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        const video = document.createElement('video')
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d', { willReadFrequently: true })
        let baseline = null

        video.muted = true
        video.playsInline = true
        video.srcObject = stream
        await video.play()

        proximityFallbackStreamRef.current = stream
        canvas.width = 24
        canvas.height = 24

        const sampleFrame = () => {
          if (!context || video.readyState < 2) {
            proximityFallbackRef.current = requestAnimationFrame(sampleFrame)
            return
          }

          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
          let brightness = 0

          for (let index = 0; index < pixels.length; index += 4) {
            brightness += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3
          }

          brightness /= pixels.length / 4
          baseline = baseline === null ? brightness : baseline * 0.95 + brightness * 0.05

          const drop = baseline > 0 ? Math.max(0, 1 - brightness / baseline) : 0
          const strength = Math.round(Math.min(drop * 180, 100))

          setProximity({
            value: { distance: Math.round(100 - strength), max: 100 },
            unit: '%',
            detail:
              strength > 55
                ? 'Camera fallback / lens occlusion detected'
                : 'Camera fallback / field clear',
            supported: true,
            active: true,
            strength,
          })

          proximityFallbackRef.current = requestAnimationFrame(sampleFrame)
        }

        setProximity((reading) => ({
          ...reading,
          detail: 'Camera occlusion fallback listening',
          supported: true,
          active: true,
        }))
        proximityFallbackRef.current = requestAnimationFrame(sampleFrame)
      } catch (error) {
        setProximity((reading) => ({
          ...reading,
          detail: error.message,
          active: false,
        }))
      }
    }

    if ('ProximitySensor' in window) {
      try {
        const sensor = new window.ProximitySensor({ frequency: 4 })
        sensor.addEventListener('reading', () => {
          const strength = sensor.max
            ? Math.round(Math.max(0, 1 - sensor.distance / sensor.max) * 100)
            : 0
          setProximity({
            value: { distance: sensor.distance, max: sensor.max },
            unit: 'cm',
            detail: sensor.near ? 'Near field interruption' : 'Field clear',
            supported: true,
            active: true,
            strength,
          })
        })
        sensor.addEventListener('error', (event) => {
          setProximity((reading) => ({
            ...reading,
            detail: event.error?.message || 'Sensor permission denied',
            active: false,
          }))
          startCameraFallback()
        })
        sensor.start()
        sensorsRef.current.proximity = sensor
        return
      } catch (error) {
        setProximity((reading) => ({ ...reading, detail: error.message }))
      }
    }

    if ('ondeviceproximity' in window) {
      const onProximity = (event) => {
        const strength = event.max
          ? Math.round(Math.max(0, 1 - event.value / event.max) * 100)
          : 0
        setProximity({
          value: { distance: event.value, max: event.max },
          unit: 'cm',
          detail: event.value < event.max * 0.25 ? 'Close object' : 'Field clear',
          supported: true,
          active: true,
          strength,
        })
      }
      legacyProximityRef.current = onProximity
      window.addEventListener('deviceproximity', onProximity)
      setProximity((reading) => ({ ...reading, detail: 'Listening', active: true }))
      return
    }

    startCameraFallback()
  }

  const startAllSensors = () => {
    startMagnetometer()
    startProximity()
    startGravity()
  }

  const startSpeechRecognition = () => {
    if (!speechSupported || recognitionRef.current) {
      if (!speechSupported) setRecorderState('Speech recognition unavailable')
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang =
      transcriptionLanguage === 'auto'
        ? navigator.language || 'en-US'
        : transcriptionLanguage
    const currentTranscript = transcriptRef.current.trim()
    finalTranscriptRef.current = currentTranscript ? `${currentTranscript} ` : ''
    latestTranscriptRef.current = currentTranscript
    recognition.onstart = () => setRecorderState('Listening and transcribing')
    recognition.onaudiostart = () => setRecorderState('Microphone open for transcription')
    recognition.onspeechstart = () => setRecorderState('Speech detected')
    recognition.onnomatch = () => setRecorderState('Speech heard, no transcript match')
    recognition.onerror = (event) => {
      setRecorderState(`Speech recognition: ${event.error || 'error'}`)
    }
    recognition.onend = () => {
      recognitionRef.current = null
      const preservedTranscript =
        latestTranscriptRef.current ||
        finalTranscriptRef.current.trim() ||
        transcriptRef.current.trim()
      if (preservedTranscript) updateTranscript(preservedTranscript)
      if (recording) setRecorderState('Media recording; transcription paused')
    }
    recognition.onresult = (event) => {
      let interimTranscript = ''

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript || ''

        if (result.isFinal) {
          finalTranscriptRef.current = `${finalTranscriptRef.current}${text} `
        } else {
          interimTranscript = `${interimTranscript}${text} `
        }
      }

      updateTranscript(`${finalTranscriptRef.current}${interimTranscript}`.trim())
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch (error) {
      recognitionRef.current = null
      setRecorderState(error.message)
    }
  }

  const stopSpeechRecognition = () => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
  }

  const startMediaRecording = async (mode) => {
    if (!('MediaRecorder' in window)) {
      setRecorderState('MediaRecorder unavailable')
      return
    }

    try {
      const stream =
        mode === 'video'
          ? await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
          : await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)

      mediaChunksRef.current = []
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      setMediaMode(mode)
      setCurrentBlob(null)
      setMediaState('Recording in progress')
      setCurrentMimeType(recorder.mimeType)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) mediaChunksRef.current.push(event.data)
      }
      recorder.onerror = (event) => {
        setMediaState(event.error?.message || 'Recorder error')
      }
      recorder.onstop = () => {
        const blob = new Blob(mediaChunksRef.current, {
          type: recorder.mimeType || (mode === 'video' ? 'video/webm' : 'audio/webm'),
        })
        setCurrentBlob(blob)
        setCurrentMimeType(blob.type)
        setRecording(false)
        setMediaState(
          blob.size > 0
            ? `${mode === 'video' ? 'Video' : 'Audio'} captured (${Math.round(
                blob.size / 1024,
              )} KB)`
            : 'Recording captured no media data',
        )
        setRecorderState('Recording captured')
        stopTracks(stream)
      }

      recorder.start(1000)
      setRecording(true)
      setRecorderState(mode === 'video' ? 'Recording video and sound' : 'Recording audio')
      startSpeechRecognition()
    } catch (error) {
      setRecorderState(error.message)
      stopTracks(mediaStreamRef.current)
    }
  }

  const stopMediaRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.requestData()
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
    stopSpeechRecognition()
  }

  const saveCurrentSession = async () => {
    const now = Date.now()
    const record = {
      id: createId(),
      title: `Session ${new Date(now).toLocaleString()}`,
      createdAt: now,
      transcript,
      transcriptionLanguage:
        transcriptionLanguage === 'auto'
          ? navigator.language || 'en-US'
          : transcriptionLanguage,
      mediaMode,
      mediaType: currentMimeType,
      audioBlob: mediaMode === 'audio' ? currentBlob : null,
      videoBlob: mediaMode === 'video' ? currentBlob : null,
      sensorSnapshot: readingSnapshot(magnetometer, proximity, gravity, disturbance),
    }

    await saveSession(record)
    updateTranscript('')
    finalTranscriptRef.current = ''
    latestTranscriptRef.current = ''
    setCurrentBlob(null)
    setMediaState('No media captured')
    await refreshSessions()
  }

  const exportRecords = async () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      format: 'ghost-hunt-session-export-v1',
      sessions: await Promise.all(sessions.map(exportableSession)),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ghost-hunt-sessions-${Date.now()}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const importRecords = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const payload = JSON.parse(await file.text())
      const records = await Promise.all((payload.sessions || []).map(importedSession))
      await importSessions(records)
      await refreshSessions()
      setStorageState(`Imported ${records.length} sessions`)
    } catch (error) {
      setStorageState(error.message)
    } finally {
      event.target.value = ''
    }
  }

  const removeRecord = async (id) => {
    await deleteSession(id)
    await refreshSessions()
  }

  const installApp = async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  if (path === '/sessions-journal') {
    return (
      <main className="app-shell">
        <AppNav path={path} onNavigate={navigate} />
        <JournalPage
          sessions={sessions}
          filteredSessions={filteredSessions}
          searchQuery={searchQuery}
          storageState={storageState}
          sqlite={sqlite}
          fileInputRef={fileInputRef}
          onSearchChange={setSearchQuery}
          onExport={exportRecords}
          onImportClick={() => fileInputRef.current?.click()}
          onImport={importRecords}
          onDelete={removeRecord}
        />
      </main>
    )
  }

  return (
    <main className="app-shell">
      <AppNav path={path} onNavigate={navigate} />
      <header className="masthead">
        <div>
          <p className="eyebrow">Field kit</p>
          <h1>Ghost Hunt</h1>
          <p className="install-prompt">Install the app for a faster field-ready experience.</p>
          <p className="lede">
            Arm every available device sensor, record audio or video evidence,
            transcribe live notes, and preserve sessions locally.
          </p>
        </div>
        <div className="install-box">
          <span>{isStandalone ? 'Installed' : 'PWA ready'}</span>
          <button type="button" disabled={!installPrompt} onClick={installApp}>
            Install
          </button>
        </div>
      </header>

      <section className="disclaimer" aria-label="How Ghost Hunt works">
        <p className="eyebrow">Privacy and operation</p>
        <p>
          Ghost Hunt reads available browser sensors and uses fallbacks such as
          device orientation, motion, and camera occlusion when native sensor APIs
          are unavailable. Audio, video, transcripts, waveform previews, and
          session records are stored locally in this browser on this device. Data
          leaves the phone only when you export it, share it, or use browser speech
          recognition services provided by the browser.
        </p>
      </section>

      <section className="signal-board" aria-label="Disturbance strength">
        <div>
          <p className="eyebrow">Disturbance index</p>
          <strong>{displayedDisturbance}%</strong>
        </div>
        <Bar label="Magnetic" value={displayedMagnetometerStrength} />
        <Bar label="Proximity" value={displayedProximityStrength} />
        <Bar label="Gravity" value={displayedGravityStrength} />
        <Bar label="Combined" value={displayedDisturbance} featured />
        <div className="signal-actions">
          <button type="button" onClick={startAllSensors}>
            Arm all sensors
          </button>
          <button type="button" className="disarm" onClick={() => disarmAllSensors()}>
            Disarm all
          </button>
          <button
            type="button"
            className={beepEnabled ? 'toggle active' : 'toggle'}
            onClick={toggleBeep}
          >
            {beepEnabled ? 'Beep on' : 'Beep off'}
          </button>
          <span>{beepState}</span>
        </div>
      </section>

      <section className="sensor-grid">
        <SensorCard
          title="Magnetometer"
          value={formatNumber(magnetometer.value, 0)}
          unit={magnetometer.unit || 'uT'}
          detail={magnetometer.detail}
          active={magnetometer.active}
          supported={magnetometer.supported}
          onStart={startMagnetometer}
        />
        <SensorCard
          title="Proximity"
          value={proximity.value ? formatNumber(proximity.value.distance, 0) : '--'}
          unit={proximity.unit || 'cm'}
          detail={proximity.detail}
          active={proximity.active}
          supported={proximity.supported}
          onStart={startProximity}
        />
        <SensorCard
          title="Gravity"
          value={gravity.value ? formatNumber(gravity.value.strength) : '--'}
          unit={gravity.unit || 'm/s2'}
          detail={gravity.detail}
          active={gravity.active}
          supported={gravity.supported}
          onStart={startGravity}
        />
      </section>

      <section className="recorder">
        <div>
          <p className="eyebrow">Evidence recorder</p>
          <h2>Audio, video, transcript</h2>
          <p>{recorderState}</p>
          <p>{mediaState}</p>
        </div>
        <div className="recorder-controls">
          <label className="select-field">
            <span>Transcription language</span>
            <select
              value={transcriptionLanguage}
              disabled={recording}
              onChange={(event) => setTranscriptionLanguage(event.target.value)}
            >
              {TRANSCRIPTION_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button
              type="button"
              disabled={recording}
              onClick={() => startMediaRecording('audio')}
            >
              Audio
            </button>
            <button
              type="button"
              disabled={recording}
              onClick={() => startMediaRecording('video')}
            >
              Video
            </button>
            <button
              type="button"
              className={recording ? 'recording' : ''}
              disabled={!recording}
              onClick={stopMediaRecording}
            >
              Stop
            </button>
          </div>
        </div>
        <textarea
          aria-label="Field notes"
          value={transcript}
          onChange={(event) => {
            updateTranscript(event.target.value)
            finalTranscriptRef.current = event.target.value.trim()
              ? `${event.target.value.trim()} `
              : ''
          }}
          placeholder="Transcribed field notes appear here..."
        />
        {currentBlob && mediaMode === 'audio' ? (
          <AudioWaveform blob={currentBlob} label="Captured waveform" />
        ) : null}
        <button
          type="button"
          disabled={!currentBlob && !transcript.trim()}
          onClick={saveCurrentSession}
        >
          Save session
        </button>
      </section>

      <section className="records">
        <div className="records-head">
          <div>
            <p className="eyebrow">Session database</p>
            <h2>Local records</h2>
            <p>{storageState}</p>
            <p>{sqlite.available ? 'SQLite ready' : sqlite.detail}</p>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => navigate('/sessions-journal')}>
              Journal
            </button>
            <button type="button" disabled={!sessions.length} onClick={exportRecords}>
              Export
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={importRecords}
            />
          </div>
        </div>
        <div className="record-list">
          {sessions.length === 0 ? (
            <p className="empty">No saved sessions yet.</p>
          ) : (
            sessions.map((session) => (
              <SessionRecord
                key={session.id}
                session={session}
                onDelete={() => removeRecord(session.id)}
              />
            ))
          )}
        </div>
      </section>
    </main>
  )
}

function Bar({ label, value, featured = false }) {
  return (
    <div className={featured ? 'bar featured' : 'bar'}>
      <div>
        <span>{label}</span>
        <strong>{value}%</strong>
      </div>
      <div className="meter">
        <span style={{ '--signal': `${value}%` }}></span>
      </div>
    </div>
  )
}

function AppNav({ path, onNavigate }) {
  const goTo = (event, nextPath) => {
    event.preventDefault()
    onNavigate(nextPath)
  }

  return (
    <nav className="app-nav" aria-label="Primary">
      <a
        href="/"
        className={path === '/' ? 'active' : ''}
        onClick={(event) => goTo(event, '/')}
      >
        Field kit
      </a>
      <a
        href="/sessions-journal"
        className={path === '/sessions-journal' ? 'active' : ''}
        onClick={(event) => goTo(event, '/sessions-journal')}
      >
        Sessions journal
      </a>
    </nav>
  )
}

function JournalPage({
  sessions,
  filteredSessions,
  searchQuery,
  storageState,
  sqlite,
  fileInputRef,
  onSearchChange,
  onExport,
  onImportClick,
  onImport,
  onDelete,
}) {
  return (
    <section className="journal-page">
      <div className="journal-head">
        <div>
          <p className="eyebrow">Sessions journal</p>
          <h1>Stored investigations</h1>
          <p>
            {filteredSessions.length} of {sessions.length} sessions shown
          </p>
        </div>
        <div className="button-row">
          <button type="button" disabled={!sessions.length} onClick={onExport}>
            Export
          </button>
          <button type="button" onClick={onImportClick}>
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            hidden
            onChange={onImport}
          />
        </div>
      </div>
      <label className="search-field">
        <span>Search sessions</span>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search title, transcript, date, media, disturbance..."
        />
      </label>
      <div className="storage-note">
        <span>{storageState}</span>
        <span>{sqlite.available ? 'SQLite ready' : sqlite.detail}</span>
      </div>
      <div className="record-list journal-list">
        {filteredSessions.length === 0 ? (
          <p className="empty">
            {sessions.length === 0 ? 'No saved sessions yet.' : 'No sessions match the search.'}
          </p>
        ) : (
          filteredSessions.map((session) => (
            <SessionRecord
              key={session.id}
              session={session}
              onDelete={() => onDelete(session.id)}
            />
          ))
        )}
      </div>
    </section>
  )
}

function SensorCard({ title, value, unit, detail, supported, active, onStart }) {
  return (
    <article className="sensor-card">
      <div className="card-top">
        <h2>{title}</h2>
        <span className={active ? 'status active' : 'status'}>
          {active ? 'Live' : supported ? 'Ready' : 'No signal'}
        </span>
      </div>
      <div className="reading">
        <strong>{value}</strong>
        <span>{unit}</span>
      </div>
      <p>{detail}</p>
      <button type="button" disabled={!supported || active} onClick={onStart}>
        Start
      </button>
    </article>
  )
}

function AudioWaveform({ blob, label = 'Audio waveform' }) {
  const canvasRef = useRef(null)
  const [status, setStatus] = useState('Rendering waveform')

  useEffect(() => {
    let cancelled = false

    const drawWaveform = async () => {
      if (!blob || !canvasRef.current) return
      if (blob.size === 0) {
        setStatus('No audio data captured')
        return
      }

      const canvas = canvasRef.current
      const pixelRatio = window.devicePixelRatio || 1
      const width = canvas.clientWidth || 720
      const height = canvas.clientHeight || 130
      canvas.width = Math.max(1, Math.floor(width * pixelRatio))
      canvas.height = Math.max(1, Math.floor(height * pixelRatio))

      const context2d = canvas.getContext('2d')
      context2d.scale(pixelRatio, pixelRatio)
      context2d.clearRect(0, 0, width, height)

      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext
        if (!AudioContext) {
          setStatus('Waveform unavailable')
          return
        }

        const audioContext = new AudioContext()
        const arrayBuffer = await blob.arrayBuffer()
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
        await audioContext.close()
        if (cancelled) return

        const data = audioBuffer.getChannelData(0)
        const samples = Math.max(1, Math.min(width, 420))
        const blockSize = Math.max(1, Math.floor(data.length / samples))
        const centerY = height / 2

        context2d.fillStyle = '#081315'
        context2d.fillRect(0, 0, width, height)
        context2d.strokeStyle = 'rgba(109, 214, 187, 0.18)'
        context2d.beginPath()
        context2d.moveTo(0, centerY)
        context2d.lineTo(width, centerY)
        context2d.stroke()

        context2d.strokeStyle = '#6dd6bb'
        context2d.lineWidth = 2
        context2d.beginPath()

        for (let index = 0; index < samples; index += 1) {
          let min = 1
          let max = -1
          const blockStart = index * blockSize

          for (let offset = 0; offset < blockSize; offset += 1) {
            const datum = data[blockStart + offset] || 0
            if (datum < min) min = datum
            if (datum > max) max = datum
          }

          const x = (index / samples) * width
          context2d.moveTo(x, centerY + min * centerY * 0.86)
          context2d.lineTo(x, centerY + max * centerY * 0.86)
        }

        context2d.stroke()
        setStatus(
          `${formatNumber(audioBuffer.duration, 1)}s / ${formatNumber(
            audioBuffer.sampleRate / 1000,
            1,
          )} kHz`,
        )
      } catch (error) {
        if (!cancelled) setStatus(error.message || 'Unable to render waveform')
      }
    }

    drawWaveform()

    return () => {
      cancelled = true
    }
  }, [blob])

  return (
    <div className="waveform">
      <div>
        <span>{label}</span>
        <strong>{status}</strong>
      </div>
      <canvas ref={canvasRef} aria-label={label}></canvas>
    </div>
  )
}

function SessionRecord({ session, onDelete }) {
  const mediaBlob = session.videoBlob || session.audioBlob
  const mediaUrl = useMemo(
    () => (mediaBlob ? URL.createObjectURL(mediaBlob) : ''),
    [mediaBlob],
  )

  useEffect(() => {
    return () => {
      if (mediaUrl) URL.revokeObjectURL(mediaUrl)
    }
  }, [mediaUrl])

  return (
    <article className="session-record">
      <div>
        <h3>{session.title}</h3>
        <p>{new Date(session.createdAt).toLocaleString()}</p>
      </div>
      <p>{session.transcript || 'No transcript saved.'}</p>
      {mediaUrl && session.videoBlob ? (
        <video controls src={mediaUrl}></video>
      ) : null}
      {mediaUrl && session.audioBlob ? (
        <>
          <audio controls src={mediaUrl}></audio>
          <AudioWaveform blob={session.audioBlob} />
        </>
      ) : null}
      <div className="record-stats">
        <span>{session.sensorSnapshot?.disturbance ?? 0}% disturbance</span>
        <span>{session.mediaMode}</span>
        {session.transcriptionLanguage ? (
          <span>{session.transcriptionLanguage}</span>
        ) : null}
      </div>
      <button type="button" onClick={onDelete}>
        Delete
      </button>
    </article>
  )
}

export default App
