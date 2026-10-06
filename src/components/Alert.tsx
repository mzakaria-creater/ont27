import type { HTMLAttributes, ReactNode } from 'react'

// Reusable alert/callout banner. ont27 already has a thin ad-hoc version of
// this (`<div className="card warn">` — a plain .card box plus a text-color
// utility, used 100+ times across the app) but it has no variant system and
// no icon/title slot. This adds a real one, in the app's own plain-CSS
// style — no class-variance-authority/cn/Tailwind — rather than retrofitting
// every existing call site.

interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'destructive'
  icon?: ReactNode
}

export function Alert({ variant = 'default', icon, className, children, ...props }: AlertProps) {
  const classes = ['alert-box', `alert-${variant}`, className].filter(Boolean).join(' ')
  return (
    <div role="alert" className={classes} {...props}>
      {icon && <span className="alert-icon" aria-hidden="true">{icon}</span>}
      <div className="alert-body">{children}</div>
    </div>
  )
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={['alert-title', className].filter(Boolean).join(' ')} {...props} />
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={['alert-description', className].filter(Boolean).join(' ')} {...props} />
}
